# emo / Eater's Minecraft Organizer

A truly open-source minecraft launcher, providing cross-platform CLI as GUI tools

# Goals

- [ ] Provide a tool to easily deploy minecraft server and clients
- [ ] Allow deploying of minecraft forge server's without hassle: e.g. `emo init forge:1.12.2`
- [ ] Create a mod repository agnostic mod pack definition, without the need of repacking mods, by passing the need to request author's for permission because of redistribution
- [ ] Create an easy to style and repack GUI launcher for groups

## Far future goals

- [ ] Allow modpack publishing over DNS records, and so emo automatically downloading it
- [ ] Add caching repository that provides mods that are deleted over time

# Project details

## `emo-sdk`

Is the heart of it all, providing bindings to create minecraft clients, servers and download mods

## `emo`

Is the cli tool, which you'll most likely be using to deploy servers

## `emo-gui`

The Launcher you're most likely will be interacting with :)
