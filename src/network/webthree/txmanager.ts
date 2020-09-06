import Web3Utils from "web3-utils";
import Big from "../../big";
const winston = require("winston");

// src.messaging
import Candidate from "../../messaging/candidate";
import Channel from "../../messaging/channel";
import Message from "../../messaging/message";
import Oracle from "../../messaging/oracle";
// src.network.webthree
import TxQueue from "./txqueue";
import FlashLiquidator from "./goldenage/flashliquidator";
import { EthNet } from "./ethnet";

/**
 * Given a list of liquidatable candidates, TxManager will participate
 * in blind-auction bidding wars and update Open Price Feed prices if
 * necessary for the liquidation.
 *
 * __IPC Messaging:__
 *
 * _Subscriptions:_
 * - Oracles>Set | Sets the txManager's oracle to the one in the message ✅
 * - Candidates>Liquidate | Appends the candidate from the message and
 *    caches an updated transaction to be sent on next bid ✅
 * - Candidates>LiquidateWithPriceUpdate | Same idea, but will make sure
 *    to update Open Price Feed prices ✅
 * - Messages>CheckCandidatesLiquidityComplete | Removes stale candidates
 *    (those that were update more than `msg.__data.time` ms ago)
 *
 * Please call `init()` as soon as possible. Bidding can't happen beforehand.
 */
export default class TxManager {

  public interval: number;
  public maxFee_Eth: number;

  private queue: TxQueue;
  private oracle: Oracle;
  private candidates: any;
  private revenue: number;
  private tx: any;

  private intervalHandle: any;

  /**
   * @param {Provider} provider the Web3 provider to use for transactions
   * @param {String} envKeyAddress Name of the environment variable containing
   *    the wallet's address
   * @param {String} envKeySecret Name of the environment variable containing
   *    the wallet's private key
   * @param {Number} interval Time between bids (milliseconds)
   * @param {Number} maxFee_Eth The maximum possible tx fee in Eth
   */
  constructor(provider, envKeyAddress, envKeySecret, interval, maxFee_Eth) {
    this.queue = new TxQueue(provider, envKeyAddress, envKeySecret);
    this.oracle = null;

    this.candidates = {};
    this.revenue = 0;
    this.tx = null;

    this.interval = interval;
    this.maxFee_Eth = maxFee_Eth;

    Channel.for(Oracle).on("Set", oracle => (this.oracle = oracle));
  }

  async init() {
    await this.queue.init();
    await this.queue.rebase();

    Channel.for(Candidate).on("Liquidate", c => {
      this._storeCandidate(c);
      this._cacheTransaction();
    });
    Channel.for(Candidate).on("LiquidateWithPriceUpdate", c => {
      this._storeCandidate(c, true);
      this._cacheTransaction();
    });
    Channel.for(Message).on("CheckCandidatesLiquidityComplete", msg => {
      this._removeStaleCandidates(msg.__data.time);
      this._cacheTransaction();
    });

    this.intervalHandle = setInterval(
      this._periodic.bind(this),
      this.interval
    );
  }

  _storeCandidate(c, needsPriceUpdate = false) {
    const isNew = !(c.address in this.candidates);

    this.candidates[c.address] = {
      repayCToken: c.ctokenidpay,
      seizeCToken: c.ctokenidseize,
      needsPriceUpdate: needsPriceUpdate,
      revenue: Number(c.profitability),
      lastSeen: Date.now()
    };

    if (isNew)
      winston.info(
        `🧮 *TxManager* | Added ${c.label} for revenue of ${c.profitability} Eth`
      );
  }

  _removeStaleCandidates(updatePeriod) {
    const now = Date.now();

    for (let addr in this.candidates) {
      if (now - this.candidates[addr].lastSeen <= updatePeriod) continue;
      delete this.candidates[addr];

      winston.info(`🧮 *TxManager* | Removed ${addr.slice(0, 6)}`);
    }
  }

  async _cacheTransaction() {
    let borrowers = [];
    let repayCTokens = [];
    let seizeCTokens = [];
    let revenue = 0;
    let needPriceUpdate: boolean = false;

    for (let addr in this.candidates) {
      const c = this.candidates[addr];

      borrowers.push(addr);
      repayCTokens.push(c.repayCToken);
      seizeCTokens.push(c.seizeCToken);
      revenue += c.revenue;
      needPriceUpdate |= c.needsPriceUpdate;
    }

    this.revenue = revenue;

    if (borrowers.length === 0) {
      this.tx = null;
      return;
    }
    const initialGasPrice =
      this.tx !== null
        ? this.tx.gasPrice
        : (await this._getInitialGasPrice()).times(0.4);

    if (!needPriceUpdate) {
      this.tx = FlashLiquidator.forNet(EthNet.mainnet).liquidateMany(
        borrowers,
        repayCTokens,
        seizeCTokens,
        initialGasPrice
      );
      return;
    }

    // TODO if oracle is null and some (but not all) candidates
    // need price updates, we should do the above code with filtered
    // versions of the lists, rather than just returning like the code below
    if (this.oracle === null) {
      this.tx = null;
      return;
    }

    const postable = this.oracle.postableData();
    this.tx = FlashLiquidator.forNet(EthNet.mainnet).liquidateManyWithPriceUpdate(
      postable[0],
      postable[1],
      postable[2],
      borrowers,
      repayCTokens,
      seizeCTokens,
      initialGasPrice
    );
  }

  /**
   * To be called every `this.interval` milliseconds.
   * Sends `this._tx` if non-null and profitable
   * @private
   */
  _periodic() {
    if (this.tx === null) {
      this.dumpAll();
      return;
    }
    this._sendIfProfitable(this.tx);
  }

  /**
   * Sends `tx` to queue as long as its gas price isn't so high that it
   * would make the transaction unprofitable
   * @private
   *
   * @param {Object} tx an object describing the transaction
   */
  _sendIfProfitable(tx) {
    // First, check that current gasPrice is profitable. If it's not (due
    // to network congestion or a recently-removed candidate), then replace
    // any pending transactions with empty ones.
    let fee = TxManager._estimateFee(this.tx);
    if (fee.gt(this.maxFee_Eth) || fee.gt(this.revenue)) {
      this.dumpAll();
      return;
    }

    // If there are no pending transactions, start a new one
    if (this.queue.length === 0) {
      this.queue.append(tx);
      return;
    }

    // If there's already a pending transaction, check whether raising
    // the gasPrice (re-bidding) results in a still-profitable tx. If it
    // does, go ahead and re-bid.
    const newTx = { ...tx };
    // Pass by reference, so after dry run, tx.gasPrice will be updated...
    this.queue.replace(0, newTx, "clip", /*dryRun*/ true);

    fee = TxManager._estimateFee(newTx);
    if (fee.gt(this.maxFee_Eth) || fee.gt(this.revenue)) return;

    this.queue.replace(0, tx, "clip");
    tx.gasPrice = newTx.gasPrice;
  }

  /**
   * Computes `gasPrice * gasLimit` and returns the result in Eth,
   * assuming that `gasPrice` was given in Wei
   * @static
   *
   * @param {Object} tx an object describing the transaction
   * @returns {Big} estimates transaction fee
   */
  static _estimateFee(tx) {
    return tx.gasPrice.times(tx.gasLimit).div(1e18);
  }

  /**
   * Gets the current market-rate gas price from the Web3 provider
   * @private
   *
   * @returns {Big} the gas price in Wei
   */
  async _getInitialGasPrice() {
    return Big(await this.queue._wallet._provider.eth.getGasPrice());
  }

  /**
   * Replaces all known pending transactions with empty transactions.
   * Intended to be run when terminating the process
   */
  dumpAll() {
    for (let i = 0; i < this.queue.length; i++) this.queue.dump(i);
  }

  /**
   * Clears candidates and dumps existing transactions
   */
  reset() {
    this.candidates = {};
    this.revenue = 0.0; // in Eth
    this.tx = null;

    this.dumpAll();
  }

  /**
   * Calls `reset()` to clear candidates and dump transactions,
   * then cancels the periodic bidding function.
   * Should be called before exiting the program
   */
  stop() {
    this.reset();
    clearInterval(this.intervalHandle);
  }
}
