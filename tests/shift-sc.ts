import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { ShiftSc } from "../target/types/shift_sc";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { PublicKey, Keypair, SystemProgram } from "@solana/web3.js";
import { assert } from "chai";

describe("shift_sc", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.ShiftSc as Program<ShiftSc>;

  let creator: Keypair;
  let voter: Keypair;
  let voter2: Keypair; // Segundo votante para tests
  let nftMint: PublicKey;
  let voterTokenAccount: PublicKey;
  let voter2TokenAccount: PublicKey;

  // UNIX ahora
  const now = Math.floor(Date.now() / 1000);

  before(async () => {
    creator = Keypair.generate();
    voter = Keypair.generate();
    voter2 = Keypair.generate();

    // Airdrops
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(creator.publicKey, 2e9),
      "confirmed"
    );
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(voter.publicKey, 2e9),
      "confirmed"
    );
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(voter2.publicKey, 2e9),
      "confirmed"
    );

    // Creamos el mint (decimals = 0)
    nftMint = await createMint(
      provider.connection,
      creator,
      creator.publicKey,
      null,
      0
    );

    // Creamos y minteamos 1 NFT al voter
    const ata = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      creator,
      nftMint,
      voter.publicKey
    );
    voterTokenAccount = ata.address;
    await mintTo(
      provider.connection,
      creator,
      nftMint,
      voterTokenAccount,
      creator,
      1
    );

    // Creamos y minteamos 1 NFT al voter2
    const ata2 = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      creator,
      nftMint,
      voter2.publicKey
    );
    voter2TokenAccount = ata2.address;
    await mintTo(
      provider.connection,
      creator,
      nftMint,
      voter2TokenAccount,
      creator,
      1
    );
  });

  it("error: crear campaña con <2 opciones", async () => {
    const title = "SoloUna";
    const opts = ["A"];
    const [campaignPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("campaign"), creator.publicKey.toBuffer(), Buffer.from(title)],
      program.programId
    );

    try {
      await program.methods
        .createCampaign(title, opts, new BN(now - 100), new BN(now + 100))
        .accounts({
          campaign: campaignPda,
          creator: creator.publicKey,
          nftMint,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([creator])
        .rpc();
      assert.fail("Debería haber rebotado por InvalidOptions");
    } catch (err: any) {
      assert.include(err.toString(), "Se requieren al menos dos opciones");
    }
  });

  it("error: crear campaña con start_time > end_time", async () => {
    const title = "FechasInvalidas";
    const opts = ["A", "B"];
    const [campaignPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("campaign"), creator.publicKey.toBuffer(), Buffer.from(title)],
      program.programId
    );

    try {
      await program.methods
        .createCampaign(title, opts, new BN(now + 1000), new BN(now + 10))
        .accounts({
          campaign: campaignPda,
          creator: creator.publicKey,
          nftMint,
          systemProgram: SystemProgram.programId,
        } as any)
        .signers([creator])
        .rpc();
      assert.fail("Debería haber rebotado por InvalidTimestamps");
    } catch (err: any) {
      assert.include(err.toString(), "Timestamps inválidos");
    }
  });

  it("happy: crear campaña válida", async () => {
    const title = "Mi Campaña";
    const opts = ["Opción1", "Opción2", "Opción3"];
    const [campaignPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("campaign"), creator.publicKey.toBuffer(), Buffer.from(title)],
      program.programId
    );

    await program.methods
      .createCampaign(title, opts, new BN(now - 10), new BN(now + 3600))
      .accounts({
        campaign: campaignPda,
        creator: creator.publicKey,
        nftMint,
        systemProgram: SystemProgram.programId,
      } as any)
      .signers([creator])
      .rpc();

    const account = await program.account.campaign.fetch(campaignPda);
    assert.equal(account.creator.toBase58(), creator.publicKey.toBase58());
    assert.equal(account.title, title);
    assert.deepEqual(account.options, opts);
    // votes viene como bigint[]
    assert.deepEqual(account.votes.map(v => Number(v)), [0, 0, 0]);
    assert.equal(Number(account.totalVotes), 0);
    // Ya no existe `account.voters`
  });

  it("error: votar antes de iniciar", async () => {
    const title = "CampañaFutura";
    const opts = ["X", "Y"];
    const [campaignPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("campaign"), creator.publicKey.toBuffer(), Buffer.from(title)],
      program.programId
    );

    // Creamos la campaña que empieza en el futuro
    await program.methods
      .createCampaign(title, opts, new BN(now + 10000), new BN(now + 20000))
      .accounts({
        campaign: campaignPda,
        creator: creator.publicKey,
        nftMint,
        systemProgram: SystemProgram.programId,
      } as any)
      .signers([creator])
      .rpc();

    try {
      await program.methods
        .castVote(0)
        .accounts({
          campaign: campaignPda,
          voter: voter.publicKey,
          voterTokenAccount,
          nftMint,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        } as any)
        .signers([voter])
        .rpc();
      assert.fail("Debería haber rebotado por CampaignNotStarted");
    } catch (err: any) {
      assert.include(err.toString(), "La campaña aún no ha comenzado");
    }
  });

  it("error: votar después de finalizar", async () => {
    const title = "CampañaPasada";
    const opts = ["X", "Y"];
    const [campaignPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("campaign"), creator.publicKey.toBuffer(), Buffer.from(title)],
      program.programId
    );

    await program.methods
      .createCampaign(title, opts, new BN(now - 20000), new BN(now - 10000))
      .accounts({
        campaign: campaignPda,
        creator: creator.publicKey,
        nftMint,
        systemProgram: SystemProgram.programId,
      } as any)
      .signers([creator])
      .rpc();

    try {
      await program.methods
        .castVote(1)
        .accounts({
          campaign: campaignPda,
          voter: voter.publicKey,
          voterTokenAccount,
          nftMint,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        } as any)
        .signers([voter])
        .rpc();
      assert.fail("Debería haber rebotado por CampaignEnded");
    } catch (err: any) {
      assert.include(err.toString(), "La campaña ya finalizó");
    }
  });

  it("error: opción inválida", async () => {
    const title = "Mi Campaña"; // reutilizamos la campaña creada anteriormente
    const [campaignPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("campaign"), creator.publicKey.toBuffer(), Buffer.from(title)],
      program.programId
    );

    try {
      await program.methods
        .castVote(99)
        .accounts({
          campaign: campaignPda,
          voter: voter.publicKey,
          voterTokenAccount,
          nftMint,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        } as any)
        .signers([voter])
        .rpc();
      assert.fail("Debería haber rebotado por InvalidOption");
    } catch (err: any) {
      assert.include(err.toString(), "Opción inválida");
    }
  });

  it("error: intentar votar sin NFT", async () => {
    const title = "CampañaSinNFT";
    const opts = ["A", "B"];
    const [campaignPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("campaign"), creator.publicKey.toBuffer(), Buffer.from(title)],
      program.programId
    );

    // Crear campaña
    await program.methods
      .createCampaign(title, opts, new BN(now - 10), new BN(now + 3600))
      .accounts({
        campaign: campaignPda,
        creator: creator.publicKey,
        nftMint,
        systemProgram: SystemProgram.programId,
      } as any)
      .signers([creator])
      .rpc();

    // Crear votante sin NFT
    const voterSinNFT = Keypair.generate();
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(voterSinNFT.publicKey, 1e9),
      "confirmed"
    );

    const ataSinNFT = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      creator,
      nftMint,
      voterSinNFT.publicKey
    );

    try {
      await program.methods
        .castVote(0)
        .accounts({
          campaign: campaignPda,
          voter: voterSinNFT.publicKey,
          voterTokenAccount: ataSinNFT.address,
          nftMint,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        } as any)
        .signers([voterSinNFT])
        .rpc();
      assert.fail("Debería haber rebotado por InsufficientTokens");
    } catch (err: any) {
      assert.include(err.toString(), "No tienes suficientes tokens para votar");
    }
  });

  it("error: intentar votar con NFT de mint incorrecto", async () => {
    const title = "CampañaNFTIncorrecto";
    const opts = ["A", "B"];
    const [campaignPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("campaign"), creator.publicKey.toBuffer(), Buffer.from(title)],
      program.programId
    );

    // Crear campaña con el mint original
    await program.methods
      .createCampaign(title, opts, new BN(now - 10), new BN(now + 3600))
      .accounts({
        campaign: campaignPda,
        creator: creator.publicKey,
        nftMint,
        systemProgram: SystemProgram.programId,
      } as any)
      .signers([creator])
      .rpc();

    // Crear un mint diferente (NFT falso)
    const fakeNftMint = await createMint(
      provider.connection,
      creator,
      creator.publicKey,
      null,
      0
    );

    // Crear votante con NFT del mint falso
    const maliciousVoter = Keypair.generate();
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(maliciousVoter.publicKey, 1e9),
      "confirmed"
    );

    const fakeTokenAccount = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      creator,
      fakeNftMint,
      maliciousVoter.publicKey
    );

    await mintTo(
      provider.connection,
      creator,
      fakeNftMint,
      fakeTokenAccount.address,
      creator,
      1
    );

    // Intentar votar con NFT del mint incorrecto debe fallar
    try {
      await program.methods
        .castVote(0)
        .accounts({
          campaign: campaignPda,
          voter: maliciousVoter.publicKey,
          voterTokenAccount: fakeTokenAccount.address,
          nftMint: fakeNftMint, // Mint incorrecto
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        } as any)
        .signers([maliciousVoter])
        .rpc();
      assert.fail("Debería haber rebotado por InvalidNFTMint");
    } catch (err: any) {
      assert.include(err.toString(), "El NFT no corresponde al mint autorizado para esta campaña");
    }
  });

  it("happy: cast vote y quema NFT", async () => {
    const title = "Mi Campaña";
    const [campaignPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("campaign"), creator.publicKey.toBuffer(), Buffer.from(title)],
      program.programId
    );

    await program.methods
      .castVote(1)
      .accounts({
        campaign: campaignPda,
        voter: voter.publicKey,
        voterTokenAccount,
        nftMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      } as any)
      .signers([voter])
      .rpc();

    const account = await program.account.campaign.fetch(campaignPda);
    assert.deepEqual(account.votes.map(v => Number(v)), [0, 1, 0]);
    assert.equal(Number(account.totalVotes), 1);
    // Ya no hay `account.voters`

    // Verificamos que el NFT fue quemado
    const ata = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      creator,
      nftMint,
      voter.publicKey
    );
    assert.equal(Number(ata.amount), 0);
  });

  it("error: intentar usar token account que no corresponde al mint de la campaña", async () => {
    const title = "CampañaTokenIncorrecto";
    const opts = ["X", "Y"];
    const [campaignPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("campaign"), creator.publicKey.toBuffer(), Buffer.from(title)],
      program.programId
    );

    // Crear campaña
    await program.methods
      .createCampaign(title, opts, new BN(now - 10), new BN(now + 3600))
      .accounts({
        campaign: campaignPda,
        creator: creator.publicKey,
        nftMint,
        systemProgram: SystemProgram.programId,
      } as any)
      .signers([creator])
      .rpc();

    // Crear otro mint
    const otherMint = await createMint(
      provider.connection,
      creator,
      creator.publicKey,
      null,
      0
    );

    // Crear votante
    const confusedVoter = Keypair.generate();
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(confusedVoter.publicKey, 1e9),
      "confirmed"
    );

    // Crear token account para el mint incorrecto
    const wrongTokenAccount = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      creator,
      otherMint,
      confusedVoter.publicKey
    );

    await mintTo(
      provider.connection,
      creator,
      otherMint,
      wrongTokenAccount.address,
      creator,
      1
    );

    // Intentar votar pasando el mint correcto pero token account incorrecto
    try {
      await program.methods
        .castVote(0)
        .accounts({
          campaign: campaignPda,
          voter: confusedVoter.publicKey,
          voterTokenAccount: wrongTokenAccount.address, // Token account del mint incorrecto
          nftMint, // Mint correcto
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        } as any)
        .signers([confusedVoter])
        .rpc();
      assert.fail("Debería haber fallado por token account incorrecto");
    } catch (err: any) {
      assert.isTrue(
        err
          .toString()
          .includes("constraint") ||
          err.toString().includes("associated_token")
      );
    }
  });

  it("error: intentar votar dos veces (doble voto)", async () => {
    const title = "CampañaDobleVoto";
    const opts = ["X", "Y"];
    const [campaignPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("campaign"), creator.publicKey.toBuffer(), Buffer.from(title)],
      program.programId
    );

    // Crear campaña
    await program.methods
      .createCampaign(title, opts, new BN(now - 10), new BN(now + 3600))
      .accounts({
        campaign: campaignPda,
        creator: creator.publicKey,
        nftMint,
        systemProgram: SystemProgram.programId,
      } as any)
      .signers([creator])
      .rpc();

    // Primer voto exitoso con voter2
    await program.methods
      .castVote(0)
      .accounts({
        campaign: campaignPda,
        voter: voter2.publicKey,
        voterTokenAccount: voter2TokenAccount,
        nftMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      } as any)
      .signers([voter2])
      .rpc();

    // Verificamos que el NFT de voter2 se quemó y no quedan tokens
    const ataPostVote = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      creator,
      nftMint,
      voter2.publicKey
    );
    assert.equal(Number(ataPostVote.amount), 0);

    // Segundo intento SIN mintear otro NFT: debe fallar por InsufficientTokens
    try {
      await program.methods
        .castVote(1)
        .accounts({
          campaign: campaignPda,
          voter: voter2.publicKey,
          voterTokenAccount: voter2TokenAccount,
          nftMint,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        } as any)
        .signers([voter2])
        .rpc();
      assert.fail("Debería haber rebotado por InsufficientTokens");
    } catch (err: any) {
      assert.include(err.toString(), "No tienes suficientes tokens para votar");
    }

    // Verificar que solo hubo un voto registrado on-chain
    const account = await program.account.campaign.fetch(campaignPda);
    assert.equal(Number(account.totalVotes), 1);
    assert.deepEqual(account.votes.map(v => Number(v)), [1, 0]);
  });

  it("happy: múltiples votantes diferentes pueden votar", async () => {
    const title = "CampañaMultiple";
    const opts = ["Opción A", "Opción B"];
    const [campaignPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("campaign"), creator.publicKey.toBuffer(), Buffer.from(title)],
      program.programId
    );

    // Crear campaña
    await program.methods
      .createCampaign(title, opts, new BN(now - 10), new BN(now + 3600))
      .accounts({
        campaign: campaignPda,
        creator: creator.publicKey,
        nftMint,
        systemProgram: SystemProgram.programId,
      } as any)
      .signers([creator])
      .rpc();

    // Crear tercer votante
    const voter3 = Keypair.generate();
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(voter3.publicKey, 1e9),
      "confirmed"
    );

    const ata3 = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      creator,
      nftMint,
      voter3.publicKey
    );
    await mintTo(
      provider.connection,
      creator,
      nftMint,
      ata3.address,
      creator,
      1
    );

    // Crear cuarto votante
    const voter4 = Keypair.generate();
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(voter4.publicKey, 1e9),
      "confirmed"
    );

    const ata4 = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      creator,
      nftMint,
      voter4.publicKey
    );
    await mintTo(
      provider.connection,
      creator,
      nftMint,
      ata4.address,
      creator,
      1
    );

    // Votar con voter3 (opción 0)
    await program.methods
      .castVote(0)
      .accounts({
        campaign: campaignPda,
        voter: voter3.publicKey,
        voterTokenAccount: ata3.address,
        nftMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      } as any)
      .signers([voter3])
      .rpc();

    // Votar con voter4 (opción 1)
    await program.methods
      .castVote(1)
      .accounts({
        campaign: campaignPda,
        voter: voter4.publicKey,
        voterTokenAccount: ata4.address,
        nftMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      } as any)
      .signers([voter4])
      .rpc();

    // Verificar resultados on-chain
    const account = await program.account.campaign.fetch(campaignPda);
    assert.deepEqual(account.votes.map(v => Number(v)), [1, 1]);
    assert.equal(Number(account.totalVotes), 2);
    // Ya no existe account.voters
  });
});
