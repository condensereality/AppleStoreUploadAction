import * as core from "@actions/core"
import * as github from "@actions/github"
import * as artifact from "@actions/artifact"
import * as os from "os"
import * as FileSystem from "fs/promises"
import * as Path from "path"
import * as Process from "process"
import * as Url from "url"

//	no __dirname or __filename in module-js node
const __dirname = Url.fileURLToPath(new URL('.', import.meta.url));

import { GetParam } from './Params.js'

const PlaformMacos = 'macos';
const PlaformIos = 'ios';
const PlaformTvos = 'tvos';
const SigningCertificateName = `Apple Distribution`;

async function DecodeBase64Param(Param)
{
	const Value64 = GetParam(Param);
	throw `Decode ${Param}`;
}

async function RunShellCommand(Command)
{
	throw `todo: RunShellCommand(${Command})`;
}

async function WritePlistChange(PlistFilename,Key,Type,Value)
{
	const Command = `plutil -replace ${Key} -${Type} ${Value} ${PlistFilename}`;
	await RunShellCommand(Command);
}

async function ModifyMacApp(AppFilename)
{
	const PlistFilename = `${AppFilename}/Contents/Info.plist`;
	Log("Set info.plist to say there are no prohibited encryption methods...");
	await WritePlistChange(PlistFilename,'ITSAppUsesNonExemptEncryption','bool','NO');
	
	Log("Copy provisioning profile into app...");
	const ProvisioningProfileFilename = `${AppFilename}/Contents/embedded.provisionprofile`;
	const ProvisioningProfileContents = DecodeBase64Param('ProvisioningProfile_Base64');
	await WriteFile(ProvisioningProfileFilename,ProvisioningProfileContents);
}

await function GetAppBundleId(AppFilename)
{
	//	read bundle id from plist
	throw `Get bundle id from app plist`;
}

//	this may be provided by user in future
await function GetEntitlementsFilename(AppFilename)
{
	const Filename = `./Entitlements.plist`;
	
	//	gr: can we extract team identifier from plist?
	const TeamIdentifier = GetParam('TeamIdentifier');
	const GetAppBundleId = await GetAppBundleId(AppFilename);
	const ApplicationIdentifier = `${TeamIdentifier}.${GetAppBundleId}`;

	//	generate entitlements file properly (using tools instead of putting in raw xml)
	await RunShellCommand(`plutil -create xml1 ${Filename}`);
	await WritePlistChange( Filename, `com.apple.security.app-sandbox`, 'bool','YES' );
	await WritePlistChange( Filename, `com.apple.security.network.client`, 'bool','YES' );
	//await WritePlistChange( Filename, `com.apple.security.network.server`, 'bool','YES' );

	//	need to insert team & app identifiers to match with provision file
	await WritePlistChange( Filename, `com.apple.application-identifier`, 'string', ApplicationIdentifier );
	await WritePlistChange( Filename, `com.apple.developer.team-identifier`, 'string', TeamIdentifier );

	return Filename;
}

async function SignApp(AppFilename)
{
	//	https://developer.apple.com/forums/thread/129980 "--deep considered harmful"
	Log(`[re-]sign dylibs inside, without entitlements...`)
	await RunShellCommand(`codesign --force --sign "${SigningCertificateName}" --deep ${AppFilename}`);

	const EntitlementsFilename = await GetEntitlementsFilename(AppFilename);
	Log(`re-sign app only & embed entitlements...`);
	await RunShellCommand(`codesign --force --entitlements ${EntitlementsFilename} --sign "${SigningCertificateName}" ${AppFilename}`);

	//	gr: codesign -d --entitlements :- Studio5.app/Contents/Frameworks/UnityPlayer.dylib should list NO ENTITLEMENTS
	//	gr: codesign -d --entitlements :- Studio5.app SHOULD have entitlements
}

async function PackageApp(AppFilename)
{
	//	eg. VK6T323P3
	const InstallerCertificateId = GetParam("InstallerCertificateId");
	
	const PackageFilename = `${AppFilename}.pkg`;
	Log(`Put signed ${AppFilename} into package ${PackageFilename}...`);
	await RunShellCommand(`xcrun productbuild --component ${AppFilename} /Applications ${PackageFilename}`);
	
	const SignedPackageFilename = `${AppFilename}.signed.pkg`;
	Log(`Sign .pkg into ${SignedPackageFilename}...`);
	await RunShellCommand(`productsign --sign ${InstallerCertificateId} ${PackageFilename} ${SignedPackageFilename}`);

	return SignedPackageFilename;
}


async function UploadArchive(ArchiveFilename,VerifyOnly=false)
{
	const Function = VerifyOnly ? `validate-app` : `upload-app`;
	
	const TestFlightPlatform = GetParam('TestFlightPlatform');

	const ApiKey = GetParam('AppStoreConnect_Auth_Key');
	const ApiIssuer = GetParam('AppStoreConnect_Auth_Issuer');

	Log(`Validate final package for upload...`);
	await RunShellCommand(`xcrun altool --${Function} --file ${ArchiveFilename} --type ${TestFlightPlatform} --apiKey ${ApiKey} --apiIssuer ${ApiIssuer}`);
}

async function VerifyArchive(ArchiveFilename)
{
	return await UploadArchive( ArchiveFilename, true );
}


async function run() 
{
	//	grab required params
	const AppFilename = GetParam('AppFilename');
	const SignApp = GetParam('SignApp') || false;
	const TestFlightPlatform = GetParam('TestFlightPlatform');
	const AppStoreConnect_Auth_Key = GetParam('AppStoreConnect_Auth_Key');
	const AppStoreConnect_Auth_P8_Base64 = GetParam('AppStoreConnect_Auth_P8_Base64');
	const AppStoreConnect_Auth_Issuer = GetParam('AppStoreConnect_Auth_Issuer');
	const AppSigningCertificate_Base64 = GetParam('AppSigningCertificate_Base64');
	const AppSigningCertificate_Password = GetParam('AppSigningCertificate_Password');
	
	let ArchiveFilename = AppFilename;
	
	if ( TestFlightPlatform == PlaformMacos )
	{
		await ModifyMacApp(AppFilename);
		await SignApp(AppFilename);
		const PackageFilename = await PackageApp(AppFilename);
		ArchiveFilename = PackageFilename;
	}
	
	await VerifyArchive(ArchiveFilename);
	await UploadArchive(ArchiveFilename);
}

//  if this throws, set a github action error
run().catch( e => core.setFailed(`${e}`) );
