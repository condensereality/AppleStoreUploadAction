Action/Shared workflow to sign & upload apps to apple's app stores.


Inputs
------------
These inputs apply to the commandline (Prefixed with `--`) as well as the action, or can be put in environment variables
- `AppFilename` path to app (`Mac.App`) or ios archive (`ios.ipa`)
- `TestFlightPlatform` `macos``ios``tvos`
- `AppStoreConnect_Auth_Key` An Auth Key from app store connect, like `1234A5B6CD`
- `AppStoreConnect_Auth_Issuer` Issuer from appstore connect (same page!) - a long hex guid `aaaaaaaa-bbbb-aaaa-dddd-12345678901`

Mac [app store] Specific
- `SignPackage=true` this will sign the package with an installer certificate. The certificate is found internally by matching the team id.
- `TeamIdentifier=AA1A111A1` Your team identifier (find this in any of your certificates in `Keychain access`)

Local Testing
-----------------
- `brew install node`
- `npm install`
- `node ./AppleAppStoreUpload.js.js`
- ```
node ./AppleAppStoreUpload.js.js `
	--AppFilename=./Mac.app
	--SignApp=true
	--TestFlightPlatform=macos --AppStoreConnect_Auth_Key=6236N3P5KF AppStoreConnect_Auth_Issuer=f3c9dc0e-3cde-4013-9b2f-1dc150f956d0 InstallerCertificateId="9VK6T323P3" SignApp=true

