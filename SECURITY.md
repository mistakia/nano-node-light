# Release Dependencies

Release Dependencies are dependencies which are inside of "dependencies" of package.json, or is installed on Release Builds.

All Release Dependencies and its Nested Dependencies MUST be deeply audited. All Release Dependencies, and its Nested Dependencies MUST be set to an absolute fixed version.

# Developer Dependencies

Developer Dependencies are dependencies which are inside of "devDependencies" of package.json, or is used under Development of this Repository.

All Developer Dependencies and its Nested Dependencies must be trusted or deeply audited.

# Use of Signatures

No signature shall be of a direct input of the User, Node, Peer or otherwise. All signatures shall be of a uncraftable value, such as a Hash.

```
Example of Bad Signature: Peer asks Node to sign a "Cookie" and the Node returns said signature, without modifying it to prevent Signature Injection.
Example of Good Signature: Peer requests vote, and the Node returns Signature of a Hash of the Requested Vote.
```
