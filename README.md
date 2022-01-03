# Scratch Link for BLE devices under Linux

This is quick and dirty implementation of Scratch Link for BLE devices under Linux. For BLE it uses D-Bus.

So far has been tested only with Intelino smart train.

## Installation

1. copy `user-ble.conf` to `/etc/dbus-1/system.d/node-ble.conf` run `sudo systemctl restart dbus`
1. install Node.js
1. clone this repo
1. in cloned directory run `npm i`

## Running

1. in cloned directory run `node .`
1. in browser visit https://localhost:20110/ and accept insecure connection
1. visit https://scratch.intelino.com/ and have a fun!
