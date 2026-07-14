var Stratum = require('../stratum/index.js');
var logging = require('../modules/logging.js');

module.exports = function()
{
    var config = JSON.parse(process.env.config);
    var coin = config.coin.name;
    var forkId = process.env.forkId;
    let shareCount = {};
    var handlers = {
        share: () => {},
        diff: () => {}
    };

    // Estimated per-worker hashrate for the dashboard, derived from accepted
    // shares (using each share's assigned difficulty, not its measured
    // shareDiff, so a lucky/unlucky individual share does not skew the
    // estimate) over a rolling window - the same convention NOMP-family
    // pools use. Sent to the master on an interval; it has no visibility
    // into other forks' workers, so it is only this fork's contribution.
    var HASHRATE_WINDOW_SECONDS = 600;
    var shareHistory = {};

    function recordShareForHashrate(worker, difficulty) {
        (shareHistory[worker] = shareHistory[worker] || []).push({
            diff: difficulty,
            time: new Date().getTime()
        });
    }

    function reportHashrates() {
        var now = new Date().getTime();
        var hashrates = {};
        Object.keys(shareHistory).forEach((worker) => {
            var entries = shareHistory[worker].filter((e) => now - e.time <= HASHRATE_WINDOW_SECONDS * 1000);
            shareHistory[worker] = entries;
            var diffSum = entries.reduce((sum, e) => sum + e.diff, 0);
            if (diffSum > 0) { hashrates[worker] = (diffSum * Math.pow(2, 32)) / HASHRATE_WINDOW_SECONDS; }
        });
        process.send({type: 'hashrateUpdate', forkId: forkId, hashrates: hashrates});
    }
    setInterval(reportHashrates, 10000);
    var emitGrayLog    = (text, owner="PoolWorker") => { logging(owner, 'gray'  , text); };
    var emitErrorLog   = (text, owner="PoolWorker") => { logging(owner, 'error'  , text); };
    var emitSpecialLog = (text, owner="PoolWorker") => { logging(owner, 'special', text); };
    
    function authorizeFN(ip, port, workerName, password, callback) {
        emitSpecialLog(`Authorized ${workerName}:${password}@${ip}`);
        callback({
            error: null,
            authorized: true,
            disconnect: false
        });
    }

    var pool = Stratum.createPool(config, authorizeFN);
    pool.start();
    process.on('message', (message) => {
        switch(message.type){
            case 'blocknotify':
                pool.processBlockNotify(message.hash, 'blocknotify script');
                break;
        };
    });
    pool.on('share', (isValidShare, isValidBlock, data) => {
            if (isValidBlock) {
                emitSpecialLog(`Block found:${data.height} Hash:${data.blockHash} block Diff:${data.blockDiff} share Diff:${data.shareDiff} finder:${data.worker}`, "Blocks");
                var api = require('../modules/api.js');
                api('block', {
                    block: data.height,
                    finder: data.worker,
                    date: new Date().getTime()
                });
                while(shareCount[data.worker] > 0) { shareCount[data.worker]=0; };
            } else if (data.blockHash && isValidBlock === undefined) {
                emitErrorLog('We thought a block was found but it was rejected by the daemon');
            };
            if (isValidShare) {
                recordShareForHashrate(data.worker, data.difficulty);
                shareCount[data.worker] = (shareCount[data.worker]+1) || 1;
                if (config.printHighShares) {
                    var sdiff = data.shareDiff;
                    var bdiff = data.blockDiffActual;
                    sillyPercent = ((sdiff * 100) / bdiff); //percent is meaningless, but it makes us feel good to see on higher diff chains like KMD
                    if (sillyPercent > 100) { emitErrorLog(`Share was found with diff higher than 100%! ${sdiff}: (${sillyPercent.toFixed(0)}%)`); } else
                    if (sillyPercent > 75) { emitSpecialLog(`Share was found with diff higher than 75%! ${sdiff}: (${sillyPercent.toFixed(0)}%)`); } else
                    if (sillyPercent > 50) { emitSpecialLog(`Share was found with diff higher than 50%! ${sdiff}: (${sillyPercent.toFixed(0)}%)`); };
                };
                if (config.printShares) {
                    if (data.blockDiffActual > data.shareDiff) {
                        emitGrayLog(`${data.height} Share accepted - Block diff:${data.blockDiffActual} Share Diff:${data.shareDiff} (${sillyPercent.toFixed(2)} %) | ${data.worker} ${shareCount[data.worker]} shares`);
                    } else {
                        emitSpecialLog(`${data.height} Share accepted - Block diff:${data.blockDiffActual} Share Diff:${data.shareDiff} | ${shareCount[data.worker]} shares`);
                    }
                };
            };
        }).on('difficultyUpdate', (workerName, diff) => {
            if (config.printVarDiffAdjust) { emitSpecialLog(`Difficulty update workerName:${JSON.stringify(workerName)} to diff:${diff}`); };
            handlers.diff(workerName, diff);
        });
}
