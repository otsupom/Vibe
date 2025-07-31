export class AMM {
	constructor(
		virtualSolReserves,
		virtualTokenReserves,
		realSolReserves,
		realTokenReserves,
		initialVirtualTokenReserves
	) {
		this.virtualSolReserves = virtualSolReserves;
		this.virtualTokenReserves = virtualTokenReserves;
		this.realSolReserves = realSolReserves;
		this.realTokenReserves = realTokenReserves;
		this.initialVirtualTokenReserves = initialVirtualTokenReserves;
	}

	static fromGlobalAccount(global) {
		return new AMM(
			global.initialVirtualSolReserves,
			global.initialVirtualTokenReserves,
			0n,
			global.initialRealTokenReserves,
			global.initialVirtualTokenReserves
		);
	}

	static fromBondingCurveAccount(bondingCurve, initialVirtualTokenReserves) {
		return new AMM(
			bondingCurve.virtualSolReserves,
			bondingCurve.virtualTokenReserves,
			bondingCurve.realSolReserves,
			bondingCurve.realTokenReserves,
			initialVirtualTokenReserves
		);
	}

	getBuyPrice(tokens) {
		const productOfReserves =
			this.virtualSolReserves * this.virtualTokenReserves;
		const newVirtualTokenReserves = this.virtualTokenReserves - tokens;
		const newVirtualSolReserves =
			productOfReserves / newVirtualTokenReserves + 1n;
		const amountNeeded =
			newVirtualSolReserves > this.virtualSolReserves
				? newVirtualSolReserves - this.virtualSolReserves
				: 0n;
		return amountNeeded > 0n ? amountNeeded : 0n;
	}

	applyBuy(tokenAmount) {
		const finalTokenAmount =
			tokenAmount > this.realTokenReserves
				? this.realTokenReserves
				: tokenAmount;
		const solAmount = this.getBuyPrice(finalTokenAmount);

		this.virtualTokenReserves = this.virtualTokenReserves - finalTokenAmount;
		this.realTokenReserves = this.realTokenReserves - finalTokenAmount;

		this.virtualSolReserves = this.virtualSolReserves + solAmount;
		this.realSolReserves = this.realSolReserves + solAmount;

		return {
			token_amount: finalTokenAmount,
			sol_amount: solAmount,
		};
	}

	applySell(tokenAmount) {
		this.virtualTokenReserves = this.virtualTokenReserves + tokenAmount;
		this.realTokenReserves = this.realTokenReserves + tokenAmount;

		const sellPrice = this.getSellPrice(tokenAmount);

		this.virtualSolReserves = this.virtualSolReserves - sellPrice;
		this.realSolReserves = this.realSolReserves - sellPrice;

		return {
			token_amount: tokenAmount,
			sol_amount: sellPrice,
		};
	}

	getSellPrice(tokens) {
		const scalingFactor = this.initialVirtualTokenReserves;
		const tokenSellProportion =
			(tokens * scalingFactor) / this.virtualTokenReserves;
		const solReceived =
			(this.virtualSolReserves * tokenSellProportion) / scalingFactor;
		return solReceived < this.realSolReserves
			? solReceived
			: this.realSolReserves;
	}
}
