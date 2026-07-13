var net = require('net');
var tls = require('tls');
var crypto = require('crypto');
var events = require('events');

var util = require('./util.js');


//Example of p2p in node from TheSeven: http://paste.pm/e54.js


const fixedLenStringBuffer = (s, len) => {
    var buff = new Buffer.alloc(len);
    buff.fill(0);
    buff.write(s);
    return buff;
};

const commandStringBuffer = (s) => fixedLenStringBuffer(s, 12);

/* Reads a set amount of bytes from a flowing stream, argument descriptions:
 - stream to read from, must have data emitter
 - amount of bytes to read
 - preRead argument can be used to set start with an existing data buffer
 - callback returns 1) data buffer and 2) lopped/over-read data */
var readFlowingBytes = function (stream, amount, preRead, callback)
{

    var buff = preRead ? preRead : new Buffer.from([]);

    var readData = function (data) {
        buff = Buffer.concat([buff, data]);

        if (buff.length >= amount) {
            var returnData = buff.slice(0, amount);
            var lopped = buff.length > amount ? buff.slice(amount) : null;
            callback(returnData, lopped);
        } else {
            stream.once('data', readData);
        }
    };

    readData(new Buffer.from([]));
};

var Peer = module.exports = function (options)
{

    var _this = this;
    var client;
    var magic = new Buffer.from(options.testnet ? options.coin.peerMagicTestnet : options.coin.peerMagic, 'hex');
    var magicInt = magic.readUInt32LE(0);
    var verack = false;
    var validConnectionConfig = true;

    //https://en.bitcoin.it/wiki/Protocol_specification#Inventory_Vectors
    var invCodes = {
        error: 0,
        tx: 1,
        block: 2
    };

    // No services (was NODE_NETWORK=1): this client only listens for new-block
    // notifications, it doesn't have a full chain to serve. Declaring
    // NODE_NETWORK claimed otherwise, and the daemon acted on it - the
    // getheaders request we can't answer in the captured handshake came from
    // that. Verus's own main.cpp just does fClient = !(nServices &
    // NODE_NETWORK), i.e. this correctly classifies us as a light client with
    // no side effect worth worrying about.
    var networkServices = new Buffer.from('0000000000000000', 'hex');
    var emptyNetAddress = new Buffer.from('010000000000000000000000000000000000ffff000000000000', 'hex');
    var userAgent = util.varStringBuffer('komodo-solomining');
    var blockStartHeight = new Buffer.from('00000000', 'hex'); //block start_height, should be empty unless only ever doing 1 coin

    //If protocol version is new enough, add do not relay transactions flag byte, outlined in BIP37
    //https://github.com/bitcoin/bips/blob/master/bip-0037.mediawiki#extensions-to-existing-messages
    var relayTransactions = options.p2p.disableTransactions === true ? new Buffer.from([false]) : new Buffer.from([]);

    // Verus's PBaaS-era protocol (src/net.cpp PushVersion, src/main.cpp
    // ProcessMessage "version") inserts an extra 20-byte identity hash between
    // the nonce and the subversion string for any peer claiming
    // protocolVersion >= 170009 (MIN_PBAAS_VERSION) - VERUS_NODEID for a peer
    // without a configured VerusID, which is just an all-zero uint160.
    // Omitting it doesn't fail cleanly: the daemon's parser has nothing to
    // read there, so it consumes 20 bytes of our subversion string instead,
    // shifting every field after it and eventually failing with
    // reject("version", REJECT_MALFORMED, "error parsing message") -
    // confirmed via packet capture and cross-referenced against VerusCoin
    // v1.2.17-1 source (the exact version running on the target node).
    var MIN_PBAAS_VERSION = 170009;
    var paymentAddressHash = options.protocolVersion >= MIN_PBAAS_VERSION ? Buffer.alloc(20) : Buffer.alloc(0);

    var commands = {
        inv: commandStringBuffer('inv'),
        addr: commandStringBuffer('addr'),
        ping: commandStringBuffer('ping'),
        verack: commandStringBuffer('verack'),
        version: commandStringBuffer('version'),
        getblocks: commandStringBuffer('getblocks')
    };


    (function init() {
        Connect();
    })();


    function Connect() {

        // Verus's real P2P peers are all TLS (confirmed via getinfo's
        // tls_established on the daemon side) - a plaintext version message
        // gets silently reset with zero bytes back, consistent with a TLS
        // record parser rejecting our first byte outright (a valid TLS
        // record's ContentType is 20-23; our magic's first byte isn't).
        // None of those peer connections have tls_verified set either, so
        // this is opportunistic encryption without a real PKI behind it -
        // rejectUnauthorized:false matches that, it's not disabling
        // anything that was actually being enforced. Once this handshake is
        // wrapped in TLS, the plaintext version/verack messages below are
        // unchanged - only the transport differs, so everything past this
        // point (SendVersion, SetupMessageParser, etc.) stays the same.
        var connectOptions = {
            host: options.p2p.host,
            port: options.p2p.port
        };

        if (options.coin.peerTls === true) {
            connectOptions.rejectUnauthorized = false;
            client = tls.connect(connectOptions, function () {
                SendVersion();
            });
        } else {
            client = net.connect(connectOptions, function () {
                SendVersion();
            });
        }

        client.on('close', function () {
            if (verack) {
                _this.emit('disconnected');
                verack = false;
                Connect();
            } else if (validConnectionConfig) {
                _this.emit('connectionRejected');
            }

        });

        client.on('error', function (e) {
            if (e.code === 'ECONNREFUSED') {
                validConnectionConfig = false;
                _this.emit('connectionFailed');
            } else {
                _this.emit('socketError', e);
            }
        });


        SetupMessageParser(client);

    }

    function SetupMessageParser(client) {

        var beginReadingMessage = function (preRead) {

            readFlowingBytes(client, 24, preRead, function (header, lopped) {
                var msgMagic = header.readUInt32LE(0);

                if (msgMagic !== magicInt) {
                    _this.emit('error', 'bad magic number from peer');

                    while (header.readUInt32LE(0) !== magicInt && header.length >= 4) {
                        header = header.slice(1);
                    }

                    if (header.readUInt32LE(0) === magicInt) {
                        beginReadingMessage(header);
                    } else {
                        beginReadingMessage(new Buffer.from([]));
                    }

                    return;
                }

                var msgCommand = header.slice(4, 16).toString();
                var msgLength = header.readUInt32LE(16);
                var msgChecksum = header.readUInt32LE(20);
                readFlowingBytes(client, msgLength, lopped, function (payload, lopped) {
                    if (util.sha256d(payload).readUInt32LE(0) !== msgChecksum) {
                        _this.emit('error', 'bad payload - failed checksum');
                        beginReadingMessage(null);
                        return;
                    }

                    HandleMessage(msgCommand, payload);
                    beginReadingMessage(lopped);
                });
            });
        };

        beginReadingMessage(null);
    }


    //Parsing inv message https://en.bitcoin.it/wiki/Protocol_specification#inv
    function HandleInv(payload) {
        //sloppy varint decoding
        var count = payload.readUInt8(0);
        payload = payload.slice(1);

        if (count >= 0xfd) {
            count = payload.readUInt16LE(0);
            payload = payload.slice(2);
        }

        while (count--) {
            switch (payload.readUInt32LE(0)) {
                case invCodes.error:
                    break;

                case invCodes.tx:
                    var tx = payload.slice(4, 36).toString('hex');
                    break;

                case invCodes.block:
                    var block = payload.slice(4, 36).toString('hex');
                    _this.emit('blockFound', block);
                    break;
            }

            payload = payload.slice(36);
        }
    }

    function HandleMessage(command, payload) {
        _this.emit('peerMessage', {command: command, payload: payload});

        switch (command) {
            case commands.inv.toString():
                HandleInv(payload);
                break;
            case commands.verack.toString():
                if (!verack) {
                    verack = true;
                    _this.emit('connected');
                }
                break;
            case commands.ping.toString():
                //how has this NOT had a feken pong all these years?
                //https://en.bitcoin.it/wiki/Protocol_documentation#pong
                SendMessage(commandStringBuffer('pong'), Buffer.alloc(0));
                break;
            default:
                break;
        }

    }

    //Message structure defined at: https://en.bitcoin.it/wiki/Protocol_specification#Message_structure
    function SendMessage(command, payload) {
        var message = Buffer.concat([
                                        magic,
                                        command,
                                        util.packUInt32LE(payload.length),
                                        util.sha256d(payload).slice(0, 4),
                                        payload
                                    ]);
        client.write(message);
        _this.emit('sentMessage', message);
    }

    function SendVersion() {
    //https://en.bitcoin.it/wiki/Protocol_documentation#version
        var payload = Buffer.concat([
                                        util.packUInt32LE(options.protocolVersion),
                                        networkServices,
                                        util.packInt64LE(Date.now() / 1000 | 0),
                                        emptyNetAddress, //addr_recv, can be empty
                                        emptyNetAddress, //addr_from, can be empty
                                        crypto.pseudoRandomBytes(8), //nonce, random unique ID
                                        paymentAddressHash, //Verus PBaaS identity hash - see comment above
                                        userAgent,
                                        blockStartHeight,
                                        relayTransactions
                                    ]);
        SendMessage(commands.version, payload);
    }

};

Peer.prototype.__proto__ = events.EventEmitter.prototype;
