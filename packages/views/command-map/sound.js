// Sound: three short synthesized cues, off until the owner turns them on.
//   needs you  two rising notes
//   finished   a soft three-note chord
//   failed     two low falling notes
// The notes are in skin.js. There is no background music.
(() => {
  const map = window.CommandMap;
  map.Sound = class {
    constructor(skin) {
      this.sounds = skin.sounds;
      this.enabled = false;
      this.last = {};
    }
    // Must be called from a click or key press: browsers only start audio on a user action.
    setEnabled(enabled) {
      this.enabled = enabled;
      if (!enabled) return;
      const Context = window.AudioContext ?? window.webkitAudioContext;
      if (!Context) return;
      this.context ??= new Context();
      void this.context.resume();
    }
    play(name) {
      const sound = this.sounds[name],
        context = this.context;
      if (!this.enabled || !context || !sound) return;
      // Several chats changing at once make one sound, not a pile of them.
      if (context.currentTime - (this.last[name] ?? -9) < 1.5) return;
      this.last[name] = context.currentTime;
      for (const [frequency, start, length] of sound.notes) {
        const oscillator = context.createOscillator(),
          gain = context.createGain(),
          at = context.currentTime + start;
        oscillator.type = sound.wave;
        oscillator.frequency.value = frequency;
        gain.gain.setValueAtTime(0, at);
        gain.gain.linearRampToValueAtTime(sound.gain, at + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, at + length);
        oscillator.connect(gain).connect(context.destination);
        oscillator.start(at);
        oscillator.stop(at + length + 0.02);
      }
    }
    dispose() {
      void this.context?.close();
    }
  };
})();
