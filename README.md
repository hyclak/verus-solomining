## Solomining for Verus (VRSC)
Fork of [TheComputerGenie/komodo-solomining](https://github.com/TheComputerGenie/komodo-solomining)
(itself forked from [aayanl/equihash-solomining](https://github.com/aayanl/equihash-solomining)),
adapted and validated for Verus (VRSC) specifically. See "Verus (VRSC) notes" below for what
changed and why. Upstream's own coins (KMD, PIRATE, TOKEL, VPRM) are untouched and unvalidated
here — this fork's focus is VRSC.
![](./Screenshot.png)
## The solo miner's solo pool
The objective is a "light-weight" pool that does what needs to be done.  
We're no longer calling this a "poxy" as that term was meant to bridge getwork and stratum and no client even has getwork anymore.  
This pool will **not** work for MCL (due to alternating blocks using CCs), to come later.  

## When all else fails: RTFM!

Requirements
------------
* node v21.4+ (installs by following "Install" below)
* coin daemon

Install (Ubuntu)
-------------
Yes, this is "a lot" for beginners to understand; however, solo mining isn't meant to be easy. Copy/paste into terminal:

```shell
NODE_MAJOR=21
sudo apt-get update
sudo apt-get install -y ca-certificates curl gnupg build-essential libsodium-dev

sudo mkdir -p /etc/apt/keyrings
curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | sudo gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg
echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_$NODE_MAJOR.x nodistro main" | sudo tee /etc/apt/sources.list.d/nodesource.list

sudo apt-get update
sudo apt-get install nodejs -y

sudo npm install npm -g

git clone https://github.com/hyclak/verus-solomining
cd verus-solomining
npm install
```

Configure
-------------
Go to config.json (or VRSC_config.json — see "Run" below) and change it to your setup.

Recomended diffs:
-------------
GPU: 300  
Minis: 3000  
Large ASICs: 30000  
Rentals: 1350000

Run
------------
```bash
node init.js          # uses config.json
node init.js VRSC     # uses VRSC_config.json instead
```
(`npm start`/`npm run startinstall` still work too, but only for the no-arg `config.json` case —
their `"$1"`-based arg passing can't actually reach `init.js` with a coin argument no matter how
you invoke npm; see "Verus (VRSC) notes" below.)

Update (normally)
-------------
```bash
git pull
```

Update (including any module changes )
-------------
```bash
git pull
rm -rf node_modules
npm install
```

Verus (VRSC) notes
------------
Fixes made in this fork to get VRSC working, for anyone adapting this to another coin:

* **`coins/VRSC.json` `peerMagic`**: don't take this from `pchMessageStart` in the daemon's
  `chainparams.cpp` source — Verus computes its actual runtime P2P magic dynamically
  (`ASSETCHAINS_MAGIC`, derived from the chain's name and total supply), and it doesn't match
  the static value in source. Get the real value from the daemon's own startup log
  (`>>>>>>>>>> VRSC: p2p.27485 rpc.27486 magic.XXXXXXXX ...`) and byte-reverse it — e.g.
  `magic.e2588aad` becomes `peerMagic: "ad8a58e2"`. It's a fixed property of the chain (derived
  from immutable name/supply), so it won't change across restarts or software upgrades.
* **`lib/stratum/transactions.js` `createGeneration`**: reads `vouts[i].valueZat` from the
  vout array (itself pulled from a `decoderawtransaction` call on the daemon's proposed
  coinbase, see `pool.js`'s `getRawTransaction`), but VRSC's `decoderawtransaction` returns
  `valueSat`, not `valueZat`. The missing field silently produced `NaN`, which threw a
  misleading "value has a fractional component" error deep in `bitgo-utxo-lib` (`NaN !== NaN`
  in JS satisfies that check same as a real fraction would). Changed to `valueSat`.
* **`init.js` coin-config selection**: read the CLI arg from `process.argv[3]`, but running
  `node init.js VRSC` (or via the `npm start`/`startinstall` scripts, which land a single arg
  at the same position) puts it at `process.argv[2]`. `argv[3]` was never populated, so
  `VRSC_config.json` (or any `<SYMBOL>_config.json`) could never actually be selected — it
  silently always fell back to the default `config.json`. Changed to `argv[2]`.
* **Known unresolved risk**: VRSC coinbase transactions include a `"cryptocondition"`-type
  vout (its reserve-currency/feepool mechanism) alongside the miner payout. `createGeneration`'s
  `switch` on `scriptPubKey.type` has no case for `"cryptocondition"` and falls through to the
  `default` case, which rebuilds it as a plain P2PKH output rather than the
  `OP_CHECKCRYPTOCONDITION` script consensus likely requires there. Its value has been `0` in
  testing so far, so this hasn't surfaced as a rejected block/share yet — but if `submitblock`
  starts failing, this is the first place to look.

Differences between this and Z-NOMP
------------
* This is meant for solo mining.
* There is no share-based pay system.
* No payments (coins go directly to the address in config).
* NO equihashverify - While this pool will work with rentals (NiceHash checked at the time of publishing), it is intended
for the true solo miner, who needs no such protection against fake shares.

Notes and known issues:
------------
* (N) VarDiff only waits 1/2 of `retargetTime` when miners first enter the pool in order to establish an initial stats set.

* (N) If the code looks like it has 9 styles of writing, that because it does. It was a long journey from NOMP to here with
many hands in the jar and no "standard" of style. Over time, the base has become the spaghetti that NOMP was written to
avoid, and over time that will be changed.

* (N KI) Web pages use online resources for css and some of the js. These min files are "standard", used on countless sites,
can be checked at your discretion, and may or may not be localized at some future point.

* (N) There is no TLS or miner banning functionality, because I'm not sure I could ever be convinced of need for a solo setup.

License
-------
Released under the GNU General Public License 3
http://www.gnu.org/licenses/gpl-3.0.html

_Forked from [aayanl/equihash-solomining](https://github.com/aayanl/equihash-solomining) which is licensed under GNU GPL v2 and now directs to WaveringAna_
[Original docs](https://rocketchat.zdeveloper.org/wiki:z-nomp_install)
