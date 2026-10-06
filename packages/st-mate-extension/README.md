# Persisto Mate for SillyTavern

Your SillyTavern character becomes a **companion**: a persistent individual with its own inner life — a mood that moves on its own, a body clock with real sleep, its own memory, and feelings that arrive only after it has read what actually passed between you.

The same affective kernel that drives [Persisto Mate for pi](https://github.com/m-rui001/Persisto-Mate) and the [DeepSeek Harness bundle](https://github.com/m-rui001/dsh-mate-companion), adapted to SillyTavern as a UI extension.

## What it does

- **An inner state that is never shown.** The `<mate>` block injected into every generation carries the clock, how long it has been quiet and how that felt, its mood, drives, how close it feels to you right now, and the memories your message stirred. The model is told to let it shape tone and length, silently.
- **Feelings are reported, never guessed.** Once a stretch of exchange is big enough to say anything, the extension asks the model you are already talking to — over a quiet generation with a JSON schema — to report how the eight Plutchik channels changed. No keyword tables.
- **Its own memory.** Nothing is filed automatically. The model decides what survives with the `mate_remember` tool (and keeps private thoughts with `mate_ponder`); recall brings memories back by the topics they were tagged with.
- **A body that lives when you are away.** State advances in closed form across every pause, so a companion left for three days wakes having actually lived through them (sleep windows included). A 60-second heartbeat keeps the clock moving while the tab is open.
- **Proactive messages, opt-in.** Impulses surface by default as inner life only. Turn `mate.proactive` on in settings (or `/mate-proactive on`) to let it voice an impulse as the current character.

## Install

SillyTavern → **Extensions → Install extension**, and paste:

```
https://github.com/m-rui001/mate-sillytavern
```

## Use

| Command | What it does |
| --- | --- |
| `/mate` | Show the companion's public mood and drives (private state is never shown) |
| `/mate-lang zh\|en` | Switch the language it thinks and speaks in |

Settings live under `extensionSettings.mate` (persisted with SillyTavern's settings.json): `lang`, `name`, `proactive`.

One companion lives across all chats — chats are channels, not selves.

## Notes

- Function calling must be enabled (and supported by your source) for `mate_remember` / `mate_ponder`.
- The companion's state is internal by design: it shapes behaviour and is never quoted back, numbers included.

## License

MIT
