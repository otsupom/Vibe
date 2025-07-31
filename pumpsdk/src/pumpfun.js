import {
	PublicKey,
	Keypair,
	Transaction,
	ComputeBudgetProgram,
} from "@solana/web3.js";
import { Program, BN } from "@coral-xyz/anchor";
import {
	createAssociatedTokenAccountInstruction,
	getAccount,
	getAssociatedTokenAddress,
} from "@solana/spl-token";
import { BondingCurveAccount } from "./bondingCurveAccount.js";
import { GlobalAccount } from "./globalAccount.js";
import { IDL } from "./IDL/index.js";
import {
	DEFAULT_COMMITMENT,
	DEFAULT_FINALITY,
	buildVersionedTx,
	getTxDetails,
	calculateWithSlippageBuy,
	calculateWithSlippageSell,
} from "./util.js";
import {
	toCreateEvent,
	toTradeEvent,
	toCompleteEvent,
	toSetParamsEvent,
} from "./events.js";
import { API_URL } from "../../src/services/config.mjs";
/**
 * Program constants
 */
const PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const MPL_TOKEN_METADATA_PROGRAM_ID =
	"metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s";

export const GLOBAL_ACCOUNT_SEED = "global";
export const BONDING_CURVE_SEED = "bonding-curve";
export const METADATA_SEED = "metadata";
export const DEFAULT_DECIMALS = 6;

export class PumpFunSDK {
	constructor(provider) {
		// console.log(IDL);
		this.program = new Program(IDL, provider);
		// console.log({ program: this.program });
		this.connection = provider.connection;
		// The wallet adapter must have publicKey + signTransaction
		this.walletAdapter = provider.wallet;
	}

	/**
	 * createAndBuy: Creates the token and buys an initial amount,
	 * using ephemeral Keypair for the mint. The user’s wallet signs.
	 *
	 * @param {Keypair} mint Ephemeral Keypair for the mint
	 * @param {object} createTokenMetadata {name, symbol, description, file, twitter, telegram, website}
	 * @param {bigint} buyAmountSol e.g. BigInt(1_000_000_000) for 1 SOL
	 * @param {bigint} slippageBasisPoints default 500n
	 * @param {object} priorityFees optional
	 * @param {string} commitment
	 * @param {string} finality
	 * @returns {Promise<{success: boolean, signature?: string, error?: string, results?: any}>}
	 */
	async createAndBuy(
		mint,
		createTokenMetadata,
		buyAmountSol,
		slippageBasisPoints = 500n,
		commitment = DEFAULT_COMMITMENT,
		finality = DEFAULT_FINALITY
	) {
		if (!this.walletAdapter?.publicKey) {
			return {
				success: false,
				error: "No wallet connected or missing publicKey.",
			};
		}

		try {
			// 1) Upload token metadata to IPFS
			const tokenMetadataUpload = await this.createTokenMetadata(
				createTokenMetadata
			);

			// 2) Build instructions for create
			const createIx = await this.getCreateInstructions(
				this.walletAdapter.publicKey,
				createTokenMetadata.name,
				createTokenMetadata.symbol,
				tokenMetadataUpload.metadataUri,
				mint
			);

			let finalTx = new Transaction().add(createIx);

			// 3) If user wants to buy immediately
			if (buyAmountSol > 0n) {
				const globalAcc = await this.getGlobalAccount(commitment);
				const buyAmount = globalAcc.getInitialBuyPrice(buyAmountSol);
				console.log("BUY AMOUNT: ", buyAmount, buyAmountSol);
				const buyAmountWithSlippage = calculateWithSlippageBuy(
					buyAmount,
					slippageBasisPoints
				);
				const buyIx = await this.getBuyInstructions(
					this.walletAdapter.publicKey,
					mint.publicKey,
					globalAcc.feeRecipient,
					new BN(buyAmount.toString()),
					new BN(buyAmountWithSlippage.toString())
				);
				finalTx.add(buyIx);
			}

			const priorityFees = {
				computeUnits: 250000,
				microLamports: 250000,
			};

			const modifyComputeUnits = ComputeBudgetProgram.setComputeUnitLimit({
				units: priorityFees.computeUnits,
			});

			const addPriorityFee = ComputeBudgetProgram.setComputeUnitPrice({
				microLamports: priorityFees.microLamports,
			});
			finalTx.add(modifyComputeUnits);
			finalTx.add(addPriorityFee);

			return await this.sendTransaction(
				finalTx,
				[mint],
				priorityFees,
				commitment,
				finality
			);
		} catch (error) {
			console.error("CreateAndBuy failed:", error);
			return {
				success: false,
				error: `CreateAndBuy failed: ${error.message || error}`,
			};
		}
	}

	/**
	 * Buys more tokens with user’s wallet paying
	 */
	async buy(
		mintPubkey,
		buyAmountSol,
		slippageBasisPoints = 500n,
		priorityFees,
		commitment = DEFAULT_COMMITMENT,
		finality = DEFAULT_FINALITY
	) {
		if (!this.walletAdapter?.publicKey) {
			return { success: false, error: "No wallet or publicKey" };
		}

		const bc = await this.getBondingCurveAccount(mintPubkey, commitment);
		if (!bc) {
			return { success: false, error: "Bonding curve not found" };
		}
		const global = await this.getGlobalAccount(commitment);

		const buyAmountWithSlippage = calculateWithSlippageBuy(
			buyAmountSol,
			slippageBasisPoints
		);

		const buyIx = await this.getBuyInstructions(
			this.walletAdapter.publicKey,
			mintPubkey,
			global.feeRecipient,
			new BN(buyAmountSol.toString()),
			new BN(buyAmountWithSlippage.toString())
		);

		let tx = new Transaction().add(buyIx);

		return await this.sendTransaction(
			tx,
			[],
			priorityFees,
			commitment,
			finality
		);
	}

	/**
	 * Sells tokens from user’s associated token account
	 */
	async sell(
		mintPubkey,
		sellTokenAmount,
		slippageBasisPoints = 500n,
		priorityFees,
		commitment = DEFAULT_COMMITMENT,
		finality = DEFAULT_FINALITY
	) {
		if (!this.walletAdapter?.publicKey) {
			return { success: false, error: "No wallet or publicKey" };
		}

		const bc = await this.getBondingCurveAccount(mintPubkey, commitment);
		if (!bc) {
			return { success: false, error: "Bonding curve not found" };
		}
		const global = await this.getGlobalAccount(commitment);

		const minSolOutput = bc.getSellPrice(
			sellTokenAmount,
			global.feeBasisPoints
		);
		const sellAmountWithSlippage = calculateWithSlippageSell(
			minSolOutput,
			slippageBasisPoints
		);

		const sellIx = await this.getSellInstructions(
			this.walletAdapter.publicKey,
			mintPubkey,
			global.feeRecipient,
			new BN(sellTokenAmount.toString()),
			new BN(sellAmountWithSlippage.toString())
		);

		let tx = new Transaction().add(sellIx);

		return await this.sendTransaction(
			tx,
			[],
			priorityFees,
			commitment,
			finality
		);
	}

	//////////
	// Internal Helpers

	async getCreateInstructions(creatorPubkey, name, symbol, uri, mint) {
		const [metadataPDA] = PublicKey.findProgramAddressSync(
			[
				Buffer.from(METADATA_SEED),
				new PublicKey(MPL_TOKEN_METADATA_PROGRAM_ID).toBuffer(),
				mint.publicKey.toBuffer(),
			],
			new PublicKey(MPL_TOKEN_METADATA_PROGRAM_ID)
		);

		const associatedBondingCurve = await getAssociatedTokenAddress(
			mint.publicKey,
			this.getBondingCurvePDA(mint.publicKey),
			true
		);

		return this.program.methods
			.create(name, symbol, uri)
			.accounts({
				mint: mint.publicKey,
				associatedBondingCurve,
				metadata: metadataPDA,
				user: creatorPubkey,
			})
			.signers([mint])
			.transaction();
	}

	async getBuyInstructions(
		buyerPubkey,
		mintPubkey,
		feeRecipientPubkey,
		amountBN,
		solCostBN
	) {
		const associatedBondingCurve = await getAssociatedTokenAddress(
			mintPubkey,
			this.getBondingCurvePDA(mintPubkey),
			true
		);
		const associatedUser = await getAssociatedTokenAddress(
			mintPubkey,
			buyerPubkey,
			false
		);

		const tx = new Transaction();
		// ensure user’s ATA
		try {
			await getAccount(this.connection, associatedUser);
		} catch (_e) {
			tx.add(
				createAssociatedTokenAccountInstruction(
					buyerPubkey,
					associatedUser,
					buyerPubkey,
					mintPubkey
				)
			);
		}

		const ix = await this.program.methods
			.buy(amountBN, solCostBN)
			.accounts({
				feeRecipient: feeRecipientPubkey,
				mint: mintPubkey,
				associatedBondingCurve,
				associatedUser,
				user: buyerPubkey,
			})
			.transaction();

		tx.add(ix);
		return tx;
	}

	async getSellInstructions(
		sellerPubkey,
		mintPubkey,
		feeRecipientPubkey,
		tokenAmountBN,
		minSolOutputBN
	) {
		const associatedBondingCurve = await getAssociatedTokenAddress(
			mintPubkey,
			this.getBondingCurvePDA(mintPubkey),
			true
		);
		const associatedUser = await getAssociatedTokenAddress(
			mintPubkey,
			sellerPubkey,
			false
		);

		const tx = new Transaction();

		const ix = await this.program.methods
			.sell(tokenAmountBN, minSolOutputBN)
			.accounts({
				feeRecipient: feeRecipientPubkey,
				mint: mintPubkey,
				associatedBondingCurve,
				associatedUser,
				user: sellerPubkey,
			})
			.transaction();

		tx.add(ix);
		return tx;
	}

	/**
	 * Sends a transaction with ephemeral signers first, then wallet signs.
	 */
	async sendTransaction(
		tx,
		ephemeralSigners,
		priorityFees,
		commitment = DEFAULT_COMMITMENT,
		finality = DEFAULT_FINALITY
	) {
		if (!this.walletAdapter?.publicKey) {
			return { success: false, error: "No wallet adapter / publicKey" };
		}

		try {
			const versionedTx = await buildVersionedTx(
				this.connection,
				this.walletAdapter.publicKey,
				tx,
				priorityFees,
				commitment
			);

			// ephemeral sign
			versionedTx.sign(ephemeralSigners);

			// user wallet final sign
			const signedTx = await this.walletAdapter.signTransaction(versionedTx);
			const sig = await this.connection.sendTransaction(signedTx, {
				skipPreflight: false,
			});

			// confirm
			const latestBlockHash = await this.connection.getLatestBlockhash();
			await this.connection.confirmTransaction(
				{
					blockhash: latestBlockHash.blockhash,
					lastValidBlockHeight: latestBlockHash.lastValidBlockHeight,
					signature: sig,
				},
				commitment
			);
			const txResult = await getTxDetails(
				this.connection,
				sig,
				commitment,
				finality
			);

			if (!txResult) {
				return { success: false, error: "Transaction not found or failed" };
			}
			return { success: true, signature: sig, results: txResult };
		} catch (err) {
			console.error("sendTransaction error:", err);
			return { success: false, error: err.message || String(err) };
		}
	}

	/**
	 * returns BondingCurveAccount or null
	 */
	async getBondingCurveAccount(mintPubkey, commitment = DEFAULT_COMMITMENT) {
		const pda = this.getBondingCurvePDA(mintPubkey);
		const info = await this.connection.getAccountInfo(pda, { commitment });
		if (!info) return null;
		return BondingCurveAccount.fromBuffer(info.data);
	}

	/**
	 * returns GlobalAccount
	 */
	async getGlobalAccount(commitment = DEFAULT_COMMITMENT) {
		const [globalPDA] = PublicKey.findProgramAddressSync(
			[Buffer.from(GLOBAL_ACCOUNT_SEED)],
			new PublicKey(PROGRAM_ID)
		);
		const info = await this.connection.getAccountInfo(globalPDA, {
			commitment,
		});
		if (!info) {
			throw new Error("Global account not found or program not inited.");
		}
		return GlobalAccount.fromBuffer(info.data);
	}

	getBondingCurvePDA(mintPubkey) {
		const [pda] = PublicKey.findProgramAddressSync(
			[Buffer.from(BONDING_CURVE_SEED), mintPubkey.toBuffer()],
			new PublicKey(PROGRAM_ID)
		);
		return pda;
	}

	/**
	 * Upload token metadata to IPFS or similar (like in the TS version).
	 */
	async createTokenMetadata({
		file,
		name,
		symbol,
		description,
		twitter,
		telegram,
		website,
	}) {
		console.log("Uploading metadata via formData...");
		if (!(file instanceof Blob)) {
			throw new Error("File must be a Blob or File object");
		}

		const formData = new FormData();
		formData.append("file", file, "image.png");
		formData.append("name", name);
		formData.append("symbol", symbol);
		formData.append("description", description);
		formData.append("twitter", twitter || "");
		formData.append("telegram", telegram || "");
		formData.append("website", website || "");
		formData.append("showName", "true");

		// need to send this to server because otherwise we cant get past cors
		const resp = await fetch(API_URL + "/ipfs", {
			method: "POST",
			body: formData,
		});
		if (!resp.ok) {
			const text = await resp.text();
			throw new Error(`Metadata upload error: ${resp.status} - ${text}`);
		}
		return await resp.json();
	}

	/**
	 * EVENT LISTENERS: createEvent, tradeEvent, etc.
	 */
	addEventListener(eventType, callback) {
		return this.program.addEventListener(
			eventType,
			(event, slot, signature) => {
				switch (eventType) {
					case "createEvent":
						callback(toCreateEvent(event), slot, signature);
						break;
					case "tradeEvent":
						callback(toTradeEvent(event), slot, signature);
						break;
					case "completeEvent":
						callback(toCompleteEvent(event), slot, signature);
						break;
					case "setParamsEvent":
						callback(toSetParamsEvent(event), slot, signature);
						break;
					default:
						console.warn("Unhandled event type:", eventType);
				}
			}
		);
	}
	removeEventListener(id) {
		this.program.removeEventListener(id);
	}
}
