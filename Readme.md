Action/Shared workflow to sign & upload apps to apple's app stores.


Inputs
------------
These inputs apply to the commandline (Prefixed with `--`) as well as the action, or can be put in environment variables
- `AppFilename` path to app (`Mac.App`) or ios archive (`ios.ipa`)
- `TestFlightPlatform` `macos``ios``tvos`
- `AppStoreConnect_Auth_Key` An Auth Key from app store connect, like `1234A5B6CD`
- `AppStoreConnect_Auth_Issuer` Issuer from appstore connect (same page!) - a long hex guid `aaaaaaaa-bbbb-aaaa-dddd-12345678901`
- `Upload=true` defaulted to true, set to false to only do a verify
	
Mac [app store] Specific
- `SignApp=true` (defaulted to true) will re-sign internal `.dylibs` and `.frameworks`, insert entitlements, modify `info.plist` with required keys and re-sign app. 
- `SignPackage=true` (defaulted to `true`) this will sign the package with an installer certificate. The certificate is found internally by matching the team id.
- `TeamIdentifier=AA1A111A1` Your team identifier (find this in any of your certificates next to your team name envin `Keychain access`, or in AppStoreConnect)
- `SigningCertificate_Base64` env or input should be a base64 encoded version of your `Apple Distribution` signing certificate exported to `.p12`
	- `base64 -i ./AppleDistribution.p12 > AppleDistribution.p12.base64.txt`
	- Copy this base64 data into a secret and pass into action
	- or testing locally
	- `export SigningCertificate_Base64=$(base64 -i ./AppleDistribution.p12)`
- `SigningCertificate_Password` env or input which is the password to the above `.p12` exported certificate
- `ProvisioningProfile_Base64` env or input should be a base64 encoded version of your `embedded.provisionprofile` that will be inserted into your .app to allow testflight to be used(provisioned)
	- `base64 -i ./embedded.provisionprofile > embedded.provisionprofile.base64.txt`
	- Copy this base64 data into a secret and pass into action
	- or testing locally
	- `export ProvisioningProfile_Base64=$(base64 -i ./embedded.provisionprofile)`
- `BundleVersion=0` if provided, a new bundle-version (`Your App 1.2.3(0)` build version) is inserted into `Info.plist` to allow re-submission of same version

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

