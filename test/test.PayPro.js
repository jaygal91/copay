'use strict';

var chai = chai || require('chai');
var should = chai.should();
var sinon = require('sinon');
var is_browser = (typeof process == 'undefined' || typeof process.versions === 'undefined');
if (is_browser) {
  var copay = require('copay'); //browser
} else {
  var copay = require('../copay'); //node
}
var copayConfig = require('../config');
var Wallet = require('../js/models/core/Wallet');
var Structure = copay.Structure;
var Storage = require('./mocks/FakeStorage');
var Network = require('./mocks/FakeNetwork');
var Blockchain = require('./mocks/FakeBlockchain');
var bitcore = bitcore || require('bitcore');
var TransactionBuilder = bitcore.TransactionBuilder;
var Transaction = bitcore.Transaction;
var Address = bitcore.Address;
var PayPro = bitcore.PayPro;
var startServer = require('./mocks/FakePayProServer');

var server;

describe('PayPro (in Wallet) model', function() {
  var config = {
    requiredCopayers: 1,
    totalCopayers: 1,
    spendUnconfirmed: true,
    reconnectDelay: 100,
    networkName: 'testnet',
  };

  var createW = function(netKey, N, conf) {
    var c = JSON.parse(JSON.stringify(conf || config));
    if (!N) N = c.totalCopayers;

    if (netKey) c.netKey = netKey;
    var mainPrivateKey = new copay.PrivateKey({
      networkName: config.networkName
    });
    var mainCopayerEPK = mainPrivateKey.deriveBIP45Branch().extendedPublicKeyString();
    c.privateKey = mainPrivateKey;

    c.publicKeyRing = new copay.PublicKeyRing({
      networkName: c.networkName,
      requiredCopayers: Math.min(N, c.requiredCopayers),
      totalCopayers: N,
    });
    c.publicKeyRing.addCopayer(mainCopayerEPK);

    c.txProposals = new copay.TxProposals({
      networkName: c.networkName,
    });

    var storage = new Storage(config.storage);
    var network = new Network(config.network);
    var blockchain = new Blockchain(config.blockchain);
    c.storage = storage;
    c.network = network;
    c.blockchain = blockchain;

    c.addressBook = {
      '2NFR2kzH9NUdp8vsXTB4wWQtTtzhpKxsyoJ': {
        label: 'John',
        copayerId: '026a55261b7c898fff760ebe14fd22a71892295f3b49e0ca66727bc0a0d7f94d03',
        createdTs: 1403102115,
        hidden: false
      },
      '2MtP8WyiwG7ZdVWM96CVsk2M1N8zyfiVQsY': {
        label: 'Jennifer',
        copayerId: '032991f836543a492bd6d0bb112552bfc7c5f3b7d5388fcbcbf2fbb893b44770d7',
        createdTs: 1403103115,
        hidden: false
      }
    };

    c.networkName = config.networkName;
    c.verbose = config.verbose;
    c.version = '0.0.1';

    return new Wallet(c);
  }

  var cachedW = null;
  var cachedWobj = null;
  var cachedCreateW = function() {
    if (!cachedW) {
      cachedW = createW();
      cachedWobj = cachedW.toObj();
      cachedWobj.opts.reconnectDelay = 100;
    }
    var w = Wallet.fromObj(cachedWobj, cachedW.storage, cachedW.network, cachedW.blockchain);
    return w;
  };

  var unspentTest = [{
    "address": "dummy",
    "scriptPubKey": "dummy",
    "txid": "2ac165fa7a3a2b535d106a0041c7568d03b531e58aeccdd3199d7289ab12cfc1",
    "vout": 1,
    "amount": 10,
    "confirmations": 7
  }];

  var createW2 = function(privateKeys, N, conf) {
    if (!N) N = 3;
    var netKey = 'T0FbU2JLby0=';
    var w = createW(netKey, N, conf);
    should.exist(w);

    var pkr = w.publicKeyRing;

    for (var i = 0; i < N - 1; i++) {
      if (privateKeys) {
        var k = privateKeys[i];
        pkr.addCopayer(k ? k.deriveBIP45Branch().extendedPublicKeyString() : null);
      } else {
        pkr.addCopayer();
      }
    }

    return w;
  };

  var cachedW2 = null;
  var cachedW2obj = null;
  var cachedCreateW2 = function() {
    if (!cachedW2) {
      cachedW2 = createW2();
      cachedW2obj = cachedW2.toObj();
      cachedW2obj.opts.reconnectDelay = 100;
    }
    var w = Wallet.fromObj(cachedW2obj, cachedW2.storage, cachedW2.network, cachedW2.blockchain);
    return w;
  };

  var createWallet = function() {
    var w = cachedCreateW2();
    unspentTest[0].address = w.publicKeyRing.getAddress(1, true, w.publicKey).toString();
    unspentTest[0].scriptPubKey = w.publicKeyRing.getScriptPubKeyHex(1, true, w.publicKey);
    w.getUnspent = function(cb) {
      return setTimeout(function() {
        return cb(null, unspentTest, []);
      }, 1);
    };
    return w;
  };

  it('#start the example server', function(done) {
    startServer(function(err, s) {
      if (err) return done(err);
      server = s;
      server.uri = 'https://localhost:8080/-';
      done();
    });
  });

  var pr;

  it('#retrieve a payment request message via http', function(done) {
    var w = createWallet();
    should.exist(w);

    var req = {
      headers: {
        'Host': 'localhost:8080',
        'Accept': PayPro.PAYMENT_REQUEST_CONTENT_TYPE
          + ', ' + PayPro.PAYMENT_ACK_CONTENT_TYPE,
        'Content-Type': 'application/octet-stream',
        'Content-Length': '0'
      },
      socket: {
        remoteAddress: 'localhost',
        remotePort: 8080
      },
      body: {}
    };

    server.POST['/-/request'](req, function(err, res, body) {
      var data = PayPro.PaymentRequest.decode(body);
      pr = new PayPro();
      pr = pr.makePaymentRequest(data);
      done();
    });
  });

  it('#send a payment message via http', function(done) {
    var w = createWallet();
    should.exist(w);

    var ver = pr.get('payment_details_version');
    var pki_type = pr.get('pki_type');
    var pki_data = pr.get('pki_data');
    var details = pr.get('serialized_payment_details');
    var sig = pr.get('signature');

    var certs = PayPro.X509Certificates.decode(pki_data);
    certs = certs.certificate;

    var verified = pr.verify();

    if (!verified) {
      return done(new Error('Server sent a bad signature.'));
    }

    details = PayPro.PaymentDetails.decode(details);
    var pd = new PayPro();
    pd = pd.makePaymentDetails(details);

    var network = pd.get('network');
    var outputs = pd.get('outputs');
    var time = pd.get('time');
    var expires = pd.get('expires');
    var memo = pd.get('memo');
    var payment_url = pd.get('payment_url');
    var merchant_data = pd.get('merchant_data');

    var opts = {
      remainderOut: {
        address: w._doGenerateAddress(true).toString()
      }
    };

    var outs = [];
    outputs.forEach(function(output) {
      outs.push({
        address: w.getAddressesStr()[0] || '2N6J45pqfu5y7zgWDwXDAmdd8qzK1oRdz3A',
        amountSatStr: '0'
      });
    });

    var b = new bitcore.TransactionBuilder(opts)
      .setUnspent(unspent)
      .setOutputs(outs);

    var selectedUtxos = b.getSelectedUnspent();
    var inputChainPaths = selectedUtxos.map(function(utxo) {
      return pkr.pathForAddress(utxo.address);
    });

    b = b.setHashToScriptMap(pkr.getRedeemScriptMap(inputChainPaths));

    if (priv) {
      var keys = priv.getForPaths(inputChainPaths);
      var signed = b.sign(keys);
    }

    outputs.forEach(function(output, i) {
      var amount = output.get('amount');
      var script = {
        offset: output.get('script').offset,
        limit: output.get('script').limit,
        buffer: output.get('script').buffer
      };

      var v = new Buffer(8);
      v[0] = (amount.low >> 0) & 0xff;
      v[1] = (amount.low >> 8) & 0xff;
      v[2] = (amount.low >> 16) & 0xff;
      v[3] = (amount.low >> 24) & 0xff;
      v[4] = (amount.high >> 0) & 0xff;
      v[5] = (amount.high >> 8) & 0xff;
      v[6] = (amount.high >> 16) & 0xff;
      v[7] = (amount.high >> 24) & 0xff;

      var s = script.buffer.slice(script.offset, script.limit);

      b.tx.outs[i].v = v;
      b.tx.outs[i].s = s;
    });

    var tx = b.build();

    var refund_outputs = [];

    var refund_to = w.publicKeyRing.getPubKeys(0, false, w.getMyCopayerId())[0];

    var total = outputs.reduce(function(total, _, i) {
      return total.add(bitcore.Bignum.fromBuffer(tx.outs[i].v, {
        endian: 'little',
        size: 1
      }));
    }, bitcore.Bignum('0', 10));

    var rpo = new PayPro();
    rpo = rpo.makeOutput();

    rpo.set('amount', +total.toString(10));

    rpo.set('script',
      Buffer.concat([
        new Buffer([
          118, // OP_DUP
          169, // OP_HASH160
          76, // OP_PUSHDATA1
          20, // number of bytes
        ]),
        // needs to be ripesha'd
        bitcore.util.sha256ripe160(options.refund_to),
        new Buffer([
          136, // OP_EQUALVERIFY
          172  // OP_CHECKSIG
        ])
      ])
    );

    refund_outputs.push(rpo.message);

    var pay = new PayPro();
    pay = pay.makePayment();
    pay.set('merchant_data', new Buffer([0, 1]));
    pay.set('transactions', [tx.serialize()]);
    pay.set('refund_to', refund_outputs);
    pay.set('memo', 'Hi server, I would like to give you some money.');

    pay = pay.serialize();

    var req = {
      headers: {
        'Host': 'localhost:8080',
        'Accept': PayPro.PAYMENT_REQUEST_CONTENT_TYPE
          + ', ' + PayPro.PAYMENT_ACK_CONTENT_TYPE,
        'Content-Type': PayPro.PAYMENT_CONTENT_TYPE,
        'Content-Length': pay.length + ''
      },
      socket: {
        remoteAddress: 'localhost',
        remotePort: 8080
      },
      body: pay,
      data: pay
    };

    server.POST['/-/pay'](req, function(err, res, body) {
      if (err) return done(err);

      var data = PayPro.PaymentACK.decode(body);
      var ack = new PayPro();
      ack = ack.makePaymentACK(data);

      var payment = ack.get('payment');
      var memo = ack.get('memo');

      payment = PayPro.Payment.decode(payment);
      var pay = new PayPro();
      payment = pay.makePayment(payment);

      var tx = payment.message.transactions[0];

      if (!tx) {
        return done(new Error('No tx in payment ACK.'));
      }

      if (tx.buffer) {
        tx.buffer = new Buffer(new Uint8Array(tx.buffer));
        tx.buffer = tx.buffer.slice(tx.offset, tx.limit);
        var ptx = new bitcore.Transaction();
        ptx.parse(tx.buffer);
        tx = ptx;
      }

      var ackTotal = outputs.reduce(function(total, _, i) {
        return total.add(bitcore.Bignum.fromBuffer(tx.outs[i].v, {
          endian: 'little',
          size: 1
        }));
      }, bitcore.Bignum('0', 10));

      assert.equal(ackTotal.toString(10), total.toString(10));

      done();
    });
  });

  it('#send a payment request', function(done) {
    var w = createWallet();
    should.exist(w);
    var address = 'bitcoin:mq7se9wy2egettFxPbmn99cK8v5AFq55Lx?amount=0.11&r=' + server.uri + '/request';
    var commentText = 'Hello, server. I\'d like to make a payment.';
    w.createTx(address, commentText, function(ntxid, merchantData) {
      if (w.totalCopayers > 1) {
        should.exist(ntxid);
        console.log('Sent TX proposal to other copayers:');
        console.log([ntxid, merchantData]);
        server.close(function() {
          done();
        });
      } else {
        console.log('Sending TX to merchant server:');
        console.log(ntxid);
        w.sendTx(ntxid, function(txid, merchantData) {
          should.exist(txid);
          console.log('TX sent:');
          console.log([ntxid, merchantData]);
          server.close(function() {
            done();
          });
        });
      }
    });
  });
});
