# Metaverse World

A virtual world technology.

License: MIT

## Why is it running so slow, I have a good GPU on my macine?

1. Hardware acceleration is turned off in Chrome (very common)
This single setting disables a whole bunch of GPU features, including WebGPU.

Go to `chrome://settings/system`
Make sure “Use graphics acceleration when available” is toggled ON
Restart Chrome completely
