# Release Dependencies
Release Dependencies are dependencies which are inside of "dependencies" of package.json, or is installed on Release Builds.

All Release Dependencies and its Nested Dependencies MUST be deeply audited. All Release Dependencies, and its Nested Dependencies MUST be set to an absolute fixed version.

# Developer Dependencies
Developer Dependencies are dependencies which are inside of "devDependencies" of package.json, or is used under Development of this Repository.

All Developer Dependencies and its Nested Dependencies must be trusted or deeply audited.
