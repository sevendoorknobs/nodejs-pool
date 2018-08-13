"use strict";
const async = require("async");
const debug = require("debug")("payments");
const request = require('request-json');
const range = require('range');
const sprintf = require("sprintf-js").sprintf;

let hexChars = new RegExp("[0-9a-f]+");

let is_full_stop = false;

function full_stop(err) {
    is_full_stop = true;
    console.error("Issue making payments: " + JSON.stringify(err));
    console.error("Will not make more payments until the payment daemon is restarted!");
    //toAddress, subject, body
    global.support.sendEmail(global.config.general.adminEmail, "Payment daemon unable to make payment",
      "Hello,\r\nThe payment daemon has hit an issue making a payment: " + JSON.stringify(err) +
      ".  Please investigate and restart the payment daemon as appropriate");
}

let paymentQueue = async.queue(function (paymentDetails, callback) {
    if (is_full_stop) {
        debug("Dropping all pending payments");
        return;
    }

    debug("Trying to make payment based on: " + JSON.stringify(paymentDetails));

    function getbalance() {
        global.support.rpcWallet("get_balance", {}, function (body) {
            if (body.hasOwnProperty('error') || !body.hasOwnProperty('result') || typeof (body.result) === 'undefined' || !body.result.hasOwnProperty('spendable')) {
                console.error("Can't getbalance: " + JSON.stringify(body.error));
                setTimeout(getbalance, 60 * 1000);
                return;
            }
            if (body.result.spendable === 0) {
                console.log("Waiting for balance to unlock after previous payment");
                setTimeout(getbalance, 5 * 60 * 1000);
                return;
            }
            console.log("Current wallet balance is " + global.support.coinToDecimal(body.result.spendable + body.result.locked_or_unconfirmed) + " with " + global.support.coinToDecimal(body.result.spendable) + " unlocked balance");

            let transferFunc = 'create_transaction';
            global.support.rpcWallet(transferFunc, paymentDetails, function (body) {
                debug("Transaction binary created - We will now send the transaction binary back to the wallet.");
                if (body.hasOwnProperty('error') || !body.hasOwnProperty('result')) {
                    if (typeof (body.error) !== 'undefined' && body.error.hasOwnProperty('message') && (body.error.message === "not enough money" || body.error.message === "not enough unlocked money")) {
                        console.error("Issue making payments, not enough money, will try later");
                        setTimeout(getbalance, 10 * 60 * 1000);
                    } else {
                        full_stop(body.error);
                    }
                    return;
                }
                callback(body.result);

                let transBinary = {
                    'binary_transaction': body.result.binary_transaction
                };
                let sendBinary = "send_transaction";

                global.support.rpcWallet(sendBinary, transBinary, function (body) {
                            debug("Sending Binary! Hold on to your horses!");
                            if (body.hasOwnProperty('error') || !body.hasOwnProperty('result')) {
                                if (typeof (body.error) !== 'undefined' && body.error.hasOwnProperty('message') && (body.error.message === "not enough money" || body.error.message === "not enough unlocked money")) {
                                    full_stop(body.error);
                                }
                                return;
                            }                   
                    debug("Payment was sent successfully.");
                });
            });
        });
    };

    getbalance();

}, 1);

paymentQueue.drain = function(){
    console.log("Payment queue drained");
    global.database.setCache('lastPaymentCycle', Math.floor(Date.now()/1000));
};

function Payee(amount, address, paymentID, bitcoin) {
    this.amount = amount;
    this.address = address;
    this.paymentID = paymentID;
    this.bitcoin = bitcoin;
    this.blockID = 0;
    this.poolType = '';
    this.transactionID = 0;
    this.sqlID = 0;
    if (paymentID === null) {
        this.id = address;
    } else {
        this.id = address + "." + paymentID;
    }
    this.fee = 0;
    this.baseFee = global.support.decimalToCoin(global.config.payout.feeSlewAmount);
    this.setFeeAmount = function () {
        if (this.amount <= global.support.decimalToCoin(global.config.payout.walletMin)) {
            this.fee = this.baseFee;
        } else if (this.amount <= global.support.decimalToCoin(global.config.payout.feeSlewEnd)) {
            let feeValue = this.baseFee / (global.support.decimalToCoin(global.config.payout.feeSlewEnd) - global.support.decimalToCoin(global.config.payout.walletMin));
            this.fee = this.baseFee - ((this.amount - global.support.decimalToCoin(global.config.payout.walletMin)) * feeValue);
        }
        this.fee = Math.floor(this.fee);
    };

    this.makePaymentWithID = function () {
        let paymentDetails = {
            transaction: {
                transfers: [
                    {
                    amount: this.amount - this.fee,
                    address: this.address
                }
            ]
            },
            anonymity: global.config.payout.mixIn,
            any_spend_address: true,
            change_address: global.config.pool.address,
            payment_id: this.paymentID
        };
        let identifier = this.id;
        let amount = this.amount;
        let address = this.address;
        let paymentID = this.paymentID;
        let payee = this;

        debug("Payment Details: " + JSON.stringify(paymentDetails));
        paymentQueue.push(paymentDetails, function (body) {            
            if (typeof body.transaction.hash !== 'undefined') {
                console.log("[*] Successful payment to " + identifier + " of " + global.support.coinToDecimal(amount) + " BCN" + " with tx_hash " + body.transaction.hash);
                global.mysql.query("INSERT INTO transactions (bitcoin, address, payment_id, xmr_amt, transaction_hash, mixin, fees, payees) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    [0, address, paymentID, amount, body.transaction.hash, global.config.payout.mixIn, global.config.payout.fee, 1]).then(function (result) {
                    if (!result.hasOwnProperty("affectedRows") || result.affectedRows != 1) {
                        console.error("Can't do: INSERT INTO transactions (bitcoin, address, payment_id, xmr_amt, transaction_hash, mixin, fees, payees) VALUES (0, '"
                            + address + "', '" + paymentID + "', " + amount + ", '" + body.transaction.hash + "', " + global.config.payout.mixIn + ", " + body.fee + ", 1)"
                        );
                        payee.transactionID = 0;
                        payee.manualPaymentShow();
                        full_stop(result);
                        return;
                    }
                    payee.transactionID = result.insertId;
                    payee.tx_hash = body.transaction.hash;
                    payee.trackPayment();
                });
            } else {
                console.error("Unknown error from the wallet: " + JSON.stringify(body));
            }
        });
    };

    this.makePaymentAsIntegrated = function () {
        let paymentDetails = {
            transaction: {
                transfers: [
                    {
                    amount: this.amount - this.fee,
                    address: this.address
                }
            ]
            },
            anonymity: global.config.payout.mixIn,
            any_spend_address: true,
            change_address: global.config.pool.address,
            payment_id: this.paymentID
        };
        let identifier = this.id;
        let amount = this.amount;
        let address = this.address;
        let payee = this;

        debug("Payment Details: " + JSON.stringify(paymentDetails));
        paymentQueue.push(paymentDetails, function (body) {
            if (typeof body.transaction.hash !== 'undefined') {
                console.log("[*] Successful payment to " + identifier + " of " + global.support.coinToDecimal(amount) + "BCN with tx_hash " + body.transaction.hash);
                global.mysql.query("INSERT INTO transactions (bitcoin, address, xmr_amt, transaction_hash, mixin, fees, payees) VALUES (?, ?, ?, ?, ?, ?, ?)",
                    [0, address, amount, body.transaction.hash, global.config.payout.mixIn, global.config.payout.fee, 1]).then(function (result) {
                    if (!result.hasOwnProperty("affectedRows") || result.affectedRows != 1) {
                        console.error("Can't do: INSERT INTO transactions (bitcoin, address, payment_id, xmr_amt, transaction_hash, mixin, fees, payees) VALUES (0, '"
                            + address + "', " + amount + ", '" + body.transaction.hash + "', " + global.config.payout.mixIn + ", " + global.config.payout.fee + ", 1)"
                        );
                        payee.transactionID = 0;
                        payee.manualPaymentShow();
                        full_stop(result);
                        return;
                    }
                    payee.transactionID = result.insertId;
                    payee.tx_hash = body.transaction.hash;
                    payee.trackPayment();
                });
            } else {
                console.error("Unknown error from the wallet: " + JSON.stringify(body));
            }
        });
    };

    this.manualPaymentShow = function () {
        console.error("Manual payment update:");
        console.error("  UPDATE balance SET amount = amount - " + this.amount + "  WHERE id = " + this.sqlID + ";");
        console.error("  INSERT INTO payments (unlocked_time, paid_time, pool_type, payment_address, transaction_id, bitcoin, amount, payment_id, transfer_fee) VALUES (now(), now(), "
          + this.poolType + ", " + this.address + ", " + this.transactionID + ", " + this.bitcoin + ", " + (this.amount - this.fee) + ", " + this.paymentID + ", " + this.fee + ");"
        );
    };

    this.trackPayment = function () {
        global.mysql.query("UPDATE balance SET amount = amount - ? WHERE id = ?", [this.amount, this.sqlID]).then(function (result) {
            if (!result.hasOwnProperty("affectedRows") || result.affectedRows != 1) {
               console.error("Can't do SQL balance update");
               this.manualPaymentShow();
               full_stop(result);
            }
        });
        global.mysql.query("INSERT INTO payments (unlocked_time, paid_time, pool_type, payment_address, transaction_id, bitcoin, amount, payment_id, transfer_fee)" +
            " VALUES (now(), now(), ?, ?, ?, ?, ?, ?, ?)", [this.poolType, this.address, this.transactionID, this.bitcoin, this.amount - this.fee, this.paymentID, this.fee]).then(function (result) {
            if (!result.hasOwnProperty("affectedRows") || result.affectedRows != 1) {
               console.error("Can't do SQL payments update");
               this.manualPaymentShow();
               full_stop(result);
            }
        });

        let payee = this;

        global.mysql.query("SELECT email FROM users WHERE username = ? AND enable_email IS true limit 1", [payee.id]).then(function (rows) {
            if (rows.length === 0) return;
            // toAddress, subject, body
            let emailData = {
                address:  payee.address,
                address2: payee.id,
                payment_amount: global.support.coinToDecimal(payee.amount),
                amount: global.support.coinToDecimal(payee.amount),
                tx_hash: payee.tx_hash
            };
            global.support.sendEmail(rows[0].email,
                sprintf("Your %(payment_amount)s BCN payment was just performed", emailData),
                sprintf(
                    "Your payment of %(payment_amount)s BCN to %(address2)s wallet was just performed and total due was decreased by %(amount)s BCN.\n" +
                    (payee.tx_hash ?
                        "Your payments transaction hash (tx_id) is %(tx_hash)s.\n"
                        : ""
                    ),
                    emailData
                ),
                payee.id
            );
        });
    };
}

function makePayments() {
    if (is_full_stop) {
        debug("Dropping all new payment creation");
        return;
    }
    if (paymentQueue.idle() === false) {
        debug("Payment queue is not empty so dropping all new payment creation");
        return;
    }

    debug("Starting makePayments");
    global.mysql.query("SELECT * FROM balance WHERE amount >= ?", [global.support.decimalToCoin(global.config.payout.walletMin)]).then(function (rows) {
        console.log("Loaded all payees into the system for processing");
        let paymentDestinations = [];
        let totalAmount = 0;
        let roundCount = 0;
        let payeeList = [];
        let payeeObjects = {};
        rows.forEach(function (row) {
            //debug("Starting round for: " + JSON.stringify(row));
            let payee = new Payee(row.amount, row.payment_address, row.payment_id, row.bitcoin);
            payeeObjects[row.payment_address] = payee;
            global.mysql.query("SELECT payout_threshold FROM users WHERE username = ?", [payee.id]).then(function (userRow) {
                ++ roundCount;
                let threshold = global.support.decimalToCoin(0.3);
                let custom_threshold = false;
                if (userRow.length !== 0 && userRow[0].payout_threshold != 0) {
                    threshold = userRow[0].payout_threshold;
                    custom_threshold = true;
                }
                payee.poolType = row.pool_type;
                payee.sqlID = row.id;
                if (payee.poolType === "fees" && payee.address === global.config.payout.feeAddress && payee.amount >= ((global.support.decimalToCoin(global.config.payout.feesForTXN) + global.support.decimalToCoin(global.config.payout.exchangeMin)))) {
                    debug("This is the fee address internal check for value");
                    payee.amount -= global.support.decimalToCoin(global.config.payout.feesForTXN);
                } else if (payee.address === global.config.payout.feeAddress && payee.poolType === "fees") {
                    debug("Unable to pay fee address.");
                    payee.amount = 0;
                }
                let remainder = payee.amount % (global.config.payout.denom * global.config.general.sigDivisor);
                if (remainder !== 0) {
                    payee.amount -= remainder;
                }
                if (payee.amount >= threshold) {
                    payee.setFeeAmount();
                    if (payee.bitcoin === 0 && payee.paymentID === null && payee.amount !== 0 && payee.amount > 0 && payee.address.length !== 106) {
                        console.log("[++] " + payee.id + " miner to bulk payment. Amount: " + global.support.coinToDecimal(payee.amount));
                        paymentDestinations.push({amount: payee.amount - payee.fee, address: payee.address});
                        totalAmount += payee.amount;
                        payeeList.push(payee);
                    } else if (payee.bitcoin === 0 && payee.paymentID === null && payee.amount !== 0 && payee.amount > 0 && payee.address.length === 106 && (payee.amount >= global.support.decimalToCoin(global.config.payout.exchangeMin) || (payee.amount > threshold && custom_threshold))) {
                        // Special code to handle integrated payment addresses.  What a pain in the rear.
                        // These are exchange addresses though, so they need to hit the exchange payout amount.
                        console.log("[+] " + payee.id + " as separate payment to integrated address. Amount: " + global.support.coinToDecimal(payee.amount));
                        payee.makePaymentAsIntegrated();
                    } else if ((payee.amount >= global.support.decimalToCoin(global.config.payout.exchangeMin) || (payee.amount > threshold && custom_threshold)) && payee.bitcoin === 0) {
                        console.log("[+] " + payee.id + " as separate payment to payment ID address. Amount: " + global.support.coinToDecimal(payee.amount));
                        payee.makePaymentWithID();
                    } else if ((payee.amount >= global.support.decimalToCoin(global.config.payout.exchangeMin) || (payee.amount > threshold && custom_threshold)) && payee.bitcoin === 1) {
                        console.log("[+] " + payee.id + " as separate payment to bitcoin. Amount: " + global.support.coinToDecimal(payee.amount));
                        payee.makeBitcoinPayment();
                    }
                }
                //debug("Went: " + roundCount + " With: " + paymentDestinations.length + " Possible destinations and: " + rows.length + " Rows");
                if (roundCount === rows.length && paymentDestinations.length > 0) {
                    while (paymentDestinations.length > 0) {
                        let paymentDetails = {
                            transaction: {
                                transfers: paymentDestinations.splice(0, global.config.payout.maxPaymentTxns)
                            },
                            anonymity: global.config.payout.mixIn,
                            any_spend_address: true,
                            change_address: "21bWtVtbfq2ftBoAkwG6XAMYXUTcoTr3WU9Ag34meyEw2ZqdSHkGo3kT9YPWj5e1Ha8fyXHbnLQJPULVvDvtE5KSVHN9SiJ"
                        };
                        console.log("Adding payment for " + paymentDetails.transaction.transfers.length + " miners");
                        paymentQueue.unshift(paymentDetails, function (body) {  //jshint ignore:line
                            // This is the only section that could potentially contain multiple txns.  Lets do this safely eh?
                            if (typeof body.transaction.hash !== 'undefined') {
                                let totalAmount = 0;
                                paymentDetails.transaction.transfers.forEach(function (payeeItem) {
                                    totalAmount += payeeObjects[payeeItem.address].amount;
                                    console.log("[**] Successful payment to " + payeeItem.address + " for " + global.support.coinToDecimal(payeeObjects[payeeItem.address].amount) + " BCN");
                                });
                                console.log("[*] Successful payment to multiple miners of " + global.support.coinToDecimal(totalAmount) + "BCN with tx_hash " + body.transaction.hash);
                                global.mysql.query("INSERT INTO transactions (bitcoin, address, payment_id, xmr_amt, transaction_hash, mixin, fees, payees) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                                    [0, null, null, totalAmount, body.transaction.hash, global.config.payout.mixIn, body.fee, paymentDetails.transaction.transfers.length]).then(function (result) {
                                    if (!result.hasOwnProperty("affectedRows") || result.affectedRows != 1) {
                                        console.error("Can't do: INSERT INTO transactions (bitcoin, address, payment_id, xmr_amt, transaction_hash, mixin, fees, payees) VALUES (0, null, null, "
                                            + totalAmount + ", '" + body.tx_hash.match(hexChars)[0] + "', " + global.config.payout.mixIn + ", " + global.config.payout.fee + ", " + paymentDetails.transaction.transfers.length + ")"
                                        );
                                        paymentDetails.transaction.transfers.forEach(function (payeeItem) {
                                            payee = payeeObjects[payeeItem.address];
                                            payee.transactionID = 0;
                                            payee.manualPaymentShow();
                                        });
                                        full_stop(result);
                                        return;
                                    }
                                    paymentDetails.transaction.transfers.forEach(function (payeeItem) {
                                        payee = payeeObjects[payeeItem.address];
                                        payee.transactionID = result.insertId;
                                        payee.tx_hash = body.transaction.hash;
                                        payee.trackPayment();
                                    });
                                });
                            } else {
                                console.error("Unknown error from the wallet: " + JSON.stringify(body));
                            }
                        });
                    }
                }
                if (roundCount === rows.length) debug("Finished processing payments for now");
            });
        });
    });
    debug("Finished makePayments");
}

function init() {

    setInterval(function () {
       console.log("Payment queue lengths: payment (" + (paymentQueue.running() + paymentQueue.length()) +")");
    }, 10*60*1000);

    makePayments();

    console.log("Setting the payment timer to: " + global.config.payout.timer + " minutes");
    setInterval(makePayments, global.config.payout.timer * 60 * 1000);
}

if (global.config.payout.timer > 35791) {
    console.error("Payout timer is too high. Please use a value under 35791 to avoid overflows.");
} else {
    init();
}