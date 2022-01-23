# Scratch Link for BLE devices under Linux

This is Scratch Link for BLE devices under Linux. For BLE it uses D-Bus.

Scratch link has been so far tested only with Intelino smart train.

## Installation

1. install Node.js 14 or newer
1. clone this repo
1. in cloned directory run `npm i`
1. copy `node_modules/@mz/bluez/user-ble.conf` to `/etc/dbus-1/system.d/user-ble.conf` run `sudo systemctl reload dbus`

## Running

1. in cloned directory run `npm start` (or `npm run debug` to get debug logs)
1. in browser visit https://device-manager.scratch.mit.edu:20110/ and accept insecure connection
1. for Intelino smart train visit https://scratch.intelino.com/ and have a fun!
