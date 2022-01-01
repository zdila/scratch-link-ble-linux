# Scratch Link for Intelino smart train under Linux

This is quick and dirty implementation of Scratch Link for Intelino smart train under Linux. For bluetooth connection it uses D-BUS.

## Installation

1. copy `user-ble.conf` to `/etc/dbus-1/system.d/node-ble.conf` run `sudo systemctl restart dbus`
1. install Node.js
1. clone this repo
1. run `npm i`
1. run `node .`
1. in browser visit https://localhost:20110/ and accept insecure connection
1. visit https://scratch.intelino.com/ and have a fun!
