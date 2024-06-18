# Understanding the Directory Structure

```
|-- bin                                 user entry point
|   |-- node.js                         spawns a node
|   |-- bootstrap-quorum-weights.js     spawns a node that bootstraps the quorum weights then exits
|-- common                              shared functions
|-- lib                                 main library
|   |-- bootstrap.js                    initializes bootstrap connections to send/receive bootstrap messages
|   |-- nano-node.js                    entry point for the node
|   |-- nano-socket.js                  manages network connections, message sending/receiving
|-- test                                unit and integration tests
```

### Note

Github workflows are in `.github/workflows`.
