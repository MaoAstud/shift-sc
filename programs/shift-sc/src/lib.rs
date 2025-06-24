use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, Burn, TokenAccount, Mint, Token},
};

declare_id!("BHVuEoVho8MgkQ937DG7HhkKy6gT1jo5xcmhA8WAJPXt");

#[program]
pub mod shift_sc {
    use super::*;

    /// Crea una nueva campaña. Ya no se almacena la lista de votantes dentro de la cuenta.
    pub fn create_campaign(
        ctx: Context<CreateCampaign>,
        title: String,
        options: Vec<String>,
        start_time: i64,
        end_time: i64,
    ) -> Result<()> {
        let campaign = &mut ctx.accounts.campaign;

        // Requerimos al menos dos opciones
        require!(options.len() > 1, VoteError::InvalidOptions);
        // El timestamp de inicio debe ser menor que el de fin
        require!(start_time < end_time, VoteError::InvalidTimestamps);

        campaign.creator = ctx.accounts.creator.key();
        campaign.title = title;
        campaign.options = options;
        campaign.votes = vec![0; campaign.options.len()];
        campaign.nft_mint = ctx.accounts.nft_mint.key();
        campaign.start_time = start_time;
        campaign.end_time = end_time;
        campaign.total_votes = 0;
        // Ya no inicializamos `voters`

        Ok(())
    }

    /// Emite un voto quemando el NFT asociado. No se verifica ni se almacena la lista de votantes on‐chain.
    pub fn cast_vote(ctx: Context<CastVote>, option_index: u8) -> Result<()> {
        let campaign = &mut ctx.accounts.campaign;
        let now = Clock::get()?.unix_timestamp;

        // 1) Validación de tiempos
        require!(now >= campaign.start_time, VoteError::CampaignNotStarted);
        require!(now <= campaign.end_time, VoteError::CampaignEnded);

        // 2) Validar que la opción exista
        require!((option_index as usize) < campaign.options.len(), VoteError::InvalidOption);

        // 3) Validación de que el NFT mint coincida con el autorizado para esta campaña
        require!(ctx.accounts.nft_mint.key() == campaign.nft_mint, VoteError::InvalidNFTMint);

        // 4) Verificar que el votante tenga al menos 1 token en su cuenta asociada
        require!(ctx.accounts.voter_token_account.amount >= 1, VoteError::InsufficientTokens);

        // 5) Quemar 1 unidad del NFT (el votante ya no podrá volver a votar, porque pierde el token)
        let cpi_accounts = Burn {
            mint: ctx.accounts.nft_mint.to_account_info(),
            from: ctx.accounts.voter_token_account.to_account_info(),
            authority: ctx.accounts.voter.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
        token::burn(cpi_ctx, 1)?;

        // 6) Actualizar conteo de votos
        campaign.votes[option_index as usize] += 1;
        campaign.total_votes += 1;

        // Ya no guardamos el Pubkey del votante dentro de la cuenta

        Ok(())
    }
}

/// Cuentas necesarias para crear una campaña
#[derive(Accounts)]
#[instruction(title: String, options: Vec<String>)]
pub struct CreateCampaign<'info> {
    /// Se inicializa la cuenta PDA de Campaign
    #[account(
        init,
        payer = creator,
        space = 8 + Campaign::MAX_SIZE,
        seeds = [b"campaign", creator.key().as_ref(), title.as_bytes()],
        bump
    )]
    pub campaign: Account<'info, Campaign>,

    /// Firma del creador de la campaña
    #[account(mut)]
    pub creator: Signer<'info>,

    /// Mint del NFT que autoriza a votar. Se usará luego en cast_vote para quemar.
    pub nft_mint: Account<'info, Mint>,

    /// Programas del sistema y SPL
    pub system_program: Program<'info, System>,
}

/// Cuentas necesarias para emitir un voto
#[derive(Accounts)]
pub struct CastVote<'info> {
    /// La cuenta Campaign (PDA) donde se almacenan los votos
    #[account(
        mut,
        seeds = [b"campaign", campaign.creator.as_ref(), campaign.title.as_bytes()],
        bump
    )]
    pub campaign: Account<'info, Campaign>,

    /// Firma del votante
    #[account(mut)]
    pub voter: Signer<'info>,

    /// Token account asociado del votante para el mint del NFT autorizado
    #[account(
        mut,
        associated_token::mint = nft_mint,
        associated_token::authority = voter,
        constraint = nft_mint.key() == campaign.nft_mint @ VoteError::InvalidNFTMint
    )]
    pub voter_token_account: Account<'info, TokenAccount>,

    /// Mint del NFT (debe coincidir con campaign.nft_mint y estar mutable para el burn)
    #[account(
        mut,
        constraint = nft_mint.key() == campaign.nft_mint @ VoteError::InvalidNFTMint
    )]
    pub nft_mint: Account<'info, Mint>,

    /// Programas de token y associated token
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
}

/// Información almacenada on‐chain sobre la campaña.
/// Ya no existe el campo `voters: Vec<Pubkey>`.
#[account]
pub struct Campaign {
    pub creator: Pubkey,
    pub title: String,
    pub options: Vec<String>,
    pub votes: Vec<u64>,
    pub nft_mint: Pubkey,
    pub start_time: i64,
    pub end_time: i64,
    pub total_votes: u64,
    // ——> Eliminado: pub voters: Vec<Pubkey>,
}

impl Campaign {
    pub const MAX_OPTIONS: usize = 10;
    pub const MAX_TITLE_LEN: usize = 64;
    // Ya no necesitamos MAX_VOTERS ni el espacio para `voters`
    pub const MAX_SIZE: usize =
        32 +                                // creator: Pubkey
        4 + Self::MAX_TITLE_LEN +           // title: String
        4 + (Self::MAX_OPTIONS * 32) +       // options: Vec<String> (hasta 10 c/u 32 bytes aprox)
        4 + (Self::MAX_OPTIONS * 8) +        // votes: Vec<u64> (hasta 10 valores de 8 bytes c/u)
        32 +                                 // nft_mint: Pubkey
        8 + 8 +                              // start_time, end_time: i64
        8;                                   // total_votes: u64
}

/// Códigos de error que pueden retornarse en las instrucciones
#[error_code]
pub enum VoteError {
    #[msg("La campaña aún no ha comenzado.")]
    CampaignNotStarted,
    #[msg("La campaña ya finalizó.")]
    CampaignEnded,
    #[msg("Opción inválida.")]
    InvalidOption,
    #[msg("Se requieren al menos dos opciones.")]
    InvalidOptions,
    #[msg("Timestamps inválidos.")]
    InvalidTimestamps,
    #[msg("No tienes suficientes tokens para votar.")]
    InsufficientTokens,
    #[msg("El NFT no corresponde al mint autorizado para esta campaña.")]
    InvalidNFTMint,
}
