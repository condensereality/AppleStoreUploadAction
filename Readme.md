Action/Shared workflow to sign & upload apps to apple's app stores.


Inputs
------------
These inputs apply to the commandline (Prefixed with `--`) as well as the action, or can be put in environment variables
- `AppFilename` path to app (`Mac.App`) or ios archive (`ios.ipa`)
- `Upload=true` defaulted to true, set to false to only do a verify
- `TestFlightPlatform` `macos``ios``tvos`
- `AppStoreConnect_Auth_Key` An Auth Key from app store connect, like `1234A5B6CD`
- `AppStoreConnect_Auth_Issuer` Issuer from appstore connect (same page!) - a long hex guid `aaaaaaaa-bbbb-aaaa-dddd-12345678901`
- `AppStoreConnect_Auth_P8_Base64` `.p8` file from AppStoreConnect encoded to base64
	- `base64 -i ./AuthKey.p8 > AuthKey.p8.base64.txt`
	- Copy this base64 data into a secret and pass into action
	- or testing locally
	- `export AppStoreConnect_Auth_P8_Base64=$(base64 -i ./AuthKey.p8)`
	
Mac [app store] Specific
- `SignApp=true` (defaulted to true) will re-sign internal `.dylibs` and `.frameworks`, insert entitlements, modify `info.plist` with required keys and re-sign app. 
- `SignPackage=true` (defaulted to `true`) this will sign the package with an installer certificate. The certificate is found internally by matching the team id.
- `TeamIdentifier=AA1A111A1` Your team identifier (find this in any of your certificates next to your team name envin `Keychain access`, or in AppStoreConnect)
- `SigningCertificate_P12_Base64` env or input should be a base64 encoded version of your `~Apple ~Distribution` signing certificate exported to `.p12`
	- Get this from [https://developer.apple.com](https://developer.apple.com) under `Certificates`, find the one for `Distribution`
	- Download the `distribution.cer` certificate and install to keychain access and should appear as `Apple Distribution: Company (TeamIdentifier)`
	- Export this to `.p12` (Must be in your `login`/personal keychain to export) with a password.
	- `base64 -i ./AppleDistribution.p12 > AppleDistribution.p12.base64.txt`
	- Copy this base64 data into a secret and pass into action
	- or testing locally
	- `export SigningCertificate_P12_Base64=$(base64 -i ./AppleDistribution.p12)`
- `SigningCertificate_Password` env or input which is the password to the above `.p12` exported certificate
- `ProvisioningProfile_Base64` env or input should be a base64 encoded version of your `embedded.provisionprofile` that will be inserted into your .app to allow testflight to be used(provisioned)
	- Get your `.provisionprofile` from [https://developer.apple.com](https://developer.apple.com) under `Profiles`, then find the provisioning profile for the `Mac App Store`. Then download.
	- `base64 -i ./embedded.provisionprofile > embedded.provisionprofile.base64.txt`
	- Copy this base64 data into a secret and pass into action
	- or testing locally
	- `export ProvisioningProfile_Base64=$(base64 -i ./embedded.provisionprofile)`
- `BundleVersion=0` if provided, a new bundle-version (`Your App 1.2.3(0)` build version) is inserted into `Info.plist` to allow re-submission of same version

Local Testing
-----------------
- Make a build, or download an artifiact from Unity cloud build with your `Mac.app` inside 
- `brew install node`
- `npm install`
- `node ./AppleAppStoreUpload.js.js`
- ```
node ./AppleAppStoreUpload.js.js `
	--AppFilename=./Mac.app
	--SignApp=true
	--TestFlightPlatform=macos 
	--AppStoreConnect_Auth_Key=1111A1A1AA
	--AppStoreConnect_Auth_Issuer=ffffffff-ffff-ffff-ffff-ffffffffffff
	--SigningCertificate_Password=password
```

