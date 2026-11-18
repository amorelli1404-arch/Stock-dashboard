/* Optional Web Audio cues. Off by default; the AudioContext is created only after the user turns it on
 * (browsers require a gesture). Each cue kind is rate-limited so a burst of prints cannot become a buzz. */
(function (g) {
  "use strict";
  var OF = (g.OF = g.OF || {});

  var CUES = {
    block: { notes: [[880, 0.09]], type: "sine", gain: 0.06 },
    sweep: { notes: [[523, 0.07], [784, 0.09]], type: "triangle", gain: 0.07 },
    absorb: { notes: [[330, 0.16]], type: "triangle", gain: 0.07 },
    pull: { notes: [[392, 0.07], [294, 0.1]], type: "sine", gain: 0.05 },
    fill: { notes: [[660, 0.06]], type: "sine", gain: 0.06 },
    lock: { notes: [[196, 0.25]], type: "sawtooth", gain: 0.05 }
  };
  var MIN_GAP_MS = 150;

  var state = { enabled: false, ctx: null, last: {} };

  function context() {
    if (state.ctx) return state.ctx;
    var Ctor = g.AudioContext || g.webkitAudioContext;
    if (!Ctor) return null;
    try { state.ctx = new Ctor(); } catch (e) { state.ctx = null; }
    return state.ctx;
  }

  function enable() {
    var ctx = context();
    if (!ctx) return false;
    if (ctx.state === "suspended" && ctx.resume) ctx.resume();
    state.enabled = true;
    return true;
  }
  function disable() { state.enabled = false; }

  function play(kind) {
    var cue = CUES[kind], ctx = state.ctx;
    if (!state.enabled || !cue || !ctx) return false;
    var now = Date.now();
    if (now - (state.last[kind] || 0) < MIN_GAP_MS) return false;
    state.last[kind] = now;
    var t = ctx.currentTime;
    cue.notes.forEach(function (n) {
      var osc = ctx.createOscillator(), gain = ctx.createGain();
      osc.type = cue.type; osc.frequency.value = n[0];
      gain.gain.setValueAtTime(cue.gain, t);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + n[1]);
      osc.connect(gain); gain.connect(ctx.destination);
      osc.start(t); osc.stop(t + n[1] + 0.02);
      t += n[1];
    });
    return true;
  }

  OF.audio = { enable: enable, disable: disable, play: play, isEnabled: function () { return state.enabled; }, cues: Object.keys(CUES) };
})(globalThis);
