import Web3Utils from "web3-utils";

import Big from "../../../big";
import SmartContract from "../smartcontract";
import { EthNet, MultiEthNet } from "../ethnet";
import { staticImplements } from "../../../utils";

const addresses = {
  [EthNet.mainnet]: "0x82c539c060E28B667B43ecBE0B12011e9b617b5e",
  [EthNet.ropsten]: "0x2ab4C66757a9934b3a0dBD91f94bE830855839cd"
};

// Cache the abi json files in memory at import time to avoid I/O during runtime
const abiMap: Map<EthNet, any> = new Map();``
for (let network in addresses) {
  let ethnet: EthNet = EthNet[network as keyof typeof EthNet];
  abiMap.set(ethnet, require(`../abis/${network}/goldenage/flashliquidator.json`));
}

@staticImplements<MultiEthNet>()
export default class FlashLiquidator extends SmartContract {

  /**
   * Factory method for constructing an instance of FlashLiquidator on a given
   * Ethereum network.
   * @param network - the network (mainnet or a testnet) to build on.
   */
  public static forNet(network: EthNet): FlashLiquidator {
    const abi: any = abiMap.get(network);
    return new FlashLiquidator(addresses[network], abi);
  }

  /**
   * Performs liquidation (SEND -- uses gas)
   *
   * @param {string} borrower address of any user with negative liquidity
   * @param {string} repayCToken address of token to repay
   * @param {string} seizeCToken address of token to seize
   * @param {Big} amount debt to repay, in units of the ordinary asset
   * @param {Number} gasPrice the gas price to use, in gwei
   * @return {Promise<Object>} the transaction object
   */
  async liquidate(borrower, repayCToken, seizeCToken, amount, gasPrice) {
    const hexAmount = Web3Utils.toHex(amount.toFixed(0));
    const method = this.inner.methods.liquidate(
      borrower,
      repayCToken,
      seizeCToken,
      hexAmount
    );
    const gasLimit = 1.07 * (await method.estimateGas({ gas: "3000000" }));

    return this._txFor(method, Big(gasLimit), gasPrice);
  }

  /**
   * Performs liquidation on multiple accounts (SEND -- uses gas)
   *
   * @param {Array<String>} borrowers addresses of users with negative liquidity
   * @param {Array<String>} repayCTokens address of token to repay
   * @param {Array<String>} seizeCTokens address of token to seize
   * @param {Number} gasPrice the gas price to use, in gwei
   * @return {Object} the transaction object
   */
  liquidateMany(borrowers, repayCTokens, seizeCTokens, gasPrice) {
    const cTokens = this._combineTokens(repayCTokens, seizeCTokens);
    const method = this.inner.methods.liquidateMany(borrowers, cTokens);
    const gasLimit = String(20 * borrowers.length) + "00000";

    return this._txFor(method, Big(gasLimit).plus(100000), gasPrice);
  }

  liquidateManyWithPriceUpdate(
    messages,
    signatures,
    symbols,
    borrowers,
    repayCTokens,
    seizeCTokens,
    gasPrice
  ) {
    const cTokens = this._combineTokens(repayCTokens, seizeCTokens);
    const method = this.inner.methods.liquidateManyWithPriceUpdate(
      messages,
      signatures,
      symbols,
      borrowers,
      cTokens
    );
    const gasLimit = String(20 * borrowers.length) + "00000";

    return this._txFor(method, Big(gasLimit).plus(400000), gasPrice);
  }

  _combineTokens(repayList, seizeList) {
    let cTokens = [];
    for (let i = 0; i < repayList.length; i++)
      cTokens.push(repayList[i], seizeList[i]);
    return cTokens;
  }
}
