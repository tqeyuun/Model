const Engine = require('./engine');
const { makeGS } = require('../build-artifact-core');
const { createStore } = require('./mockdb');
async function makeViewers(names, { latency = 0, owner = names[0] } = {}) {
  const store = createStore(), out = {};
  for (const n of names) {
    const e = new Engine({ db: store.viewer({ latency, name: n }), uid: 'u' + n + 'abcdefghijklmnop', isOwner: n === owner, makeGS });
    e.gs.CFG.LUCKY_CHANCE = 0;
    await e.start();
    out[n] = e;
  }
  return { store, v: out };
}
module.exports = { makeViewers };
