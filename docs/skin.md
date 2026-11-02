# Minecraft skin

There are two different “skins” in this project:

1. **The DSH plugin icon** — `icon.svg`, the classic Alex face shown on the plugin/market card. It is shipped with the plugin and needs no server support.
2. **The in-game player skin** — what other players see on the Alex entity. This is **not controlled by mineflayer**. The server decides which profile/textures to send to clients.

## Why the in-game skin can be “someone else”

- With `online-mode=false` (the local dev server), the server issues an offline UUID and usually has no signed texture property. Clients fall back to a default Steve/Alex skin chosen from the UUID, or to whatever a skin plugin/resource pack applies.
- Mineflayer only speaks the player protocol; it cannot inject a texture property into the server's `player_info` packets for other clients.
- Changing the bot's username or client mod may change what you see, but it does not make the server send the Alex texture.

## Fix on the local Paper dev server (SkinsRestorer)

The local server in `~/MineMate` has `SkinsRestorer.jar` in `.local/mc-data/plugins/`
(Paper 1.21.6, SkinsRestorer 15.12.6). After the server restart, the working command
is the player command:

```text
/skin set Alex
```

Send it from the Alex client (the bot, or a manually connected Alex). SkinsRestorer
resolves the `alex` skin from its database and stores it for the offline UUID. The
server applies it on the next join; the plugin's `autoConnect` will reconnect Alex.

Verified state on this machine:

- `.local/mc-data/plugins/SkinsRestorer/players/36532b5e-….player`:
  `skinIdentifier: { identifier: "alex", type: "CUSTOM" }`
- A mineflayer observer sees Alex's profile as:
  `{ url: "http://textures.minecraft.net/texture/fb9ab3483f8106ecc9e76bd47c71312b0f16a58784d606864f3b3e9cb1fd7b6c", model: "slim" }`
  — the classic Alex slim model.
- The `.playerskin` file left by an earlier `/skin url` attempt is not the active
  record; the player record above is what the server applies.

The RCON admin subcommands (`sr ...`) are asynchronous in this version and do not
return useful output over RCON; the in-game `/skin set` command is the reliable path.

If you prefer not to use a skin plugin:

- Set the server to `online-mode=true` and connect with a real Microsoft account whose skin is the Alex skin.
- Or use a server-side resource pack / skin provider of your choice.

## Plugin icon

`icon.svg` is the only visual this plugin ships. It is intentionally the Alex face, not a generic/default plugin icon.
