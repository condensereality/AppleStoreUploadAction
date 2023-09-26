import * as core from "@actions/core"
import * as github from "@actions/github"
import * as artifact from "@actions/artifact"
import * as os from "os"
import * as FileSystem from "fs/promises"
import { spawn } from "child_process";
//import * as Url from "url"

//	no __dirname or __filename in module-js node
//const __dirname = Url.fileURLToPath(new URL('.', import.meta.url));

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



//	returns
//	{ .ExitCode=0, .StdOut=[], .StdErr=[] }
//	or throws on error
async function RunShellCommand(ExeAndArguments,ThrowOnNonZeroExitCode=true)
{
	if ( !ExeAndArguments )
		ExeAndArguments = [];
	//	expecting an array of args, but allow a simple string
	if ( typeof ExeAndArguments == typeof '' )
		ExeAndArguments = ExeAndArguments.split(' ');
	
	//	pop first as exe
	const Exe = ExeAndArguments.shift();
	const Arguments = ExeAndArguments;
	
	//console.log(`Running process [${Exe}], args=${Arguments}...`);
	const Process = spawn( Exe, Arguments );
	
	//	promise throws or returns exit code
	const ProcessPromise = CreatePromise();
	//	capture everything
	const StdOut = [];
	const StdErr = [];

	function OnStdOut(Data)
	{
		//	convert node's Buffer output (which ends in linefeed)
		Data = Data.toString().trimEnd();
		StdOut.push(Data);
	}
	function OnStdErr(Data)
	{
		Data = Data.toString().trimEnd();
		StdErr.push(Data);
	}
	function OnError(Error)
	{
		if ( Error.message )
			Error = Error.message;

		ProcessPromise.Reject(Error);
	}
	function OnProcessExit(ExitCode)
	{
		//console.log(`OnProcessExit(${ExitCode}) null=crash`);
		if ( ExitCode === null )
			return OnError(`Null exit code from process (crash?)`);
			
		ProcessPromise.Resolve(ExitCode);
	}
	Process.on('error',OnError);
	Process.stdout.on('data',OnStdOut);
	Process.stderr.on('data',OnStdErr);
	Process.on("close",OnProcessExit);

	const ExitCode = await ProcessPromise;
	if ( ExitCode != 0 )
	{
		if ( ThrowOnNonZeroExitCode )
			throw `Process exit code ${ExitCode}; stdout=${StdOut} stderr=${StdErr}`;
		console.warn(`Process exit code ${ExitCode}; stdout=${StdOut} stderr=${StdErr}`);
	}
	
	//	turn arrays into something slightly easier to use (a string or null)
	function GetNiceOutput(OutputData)
	{
		if ( OutputData.length == 0 )
			return null;
		if ( OutputData.length == 1 )
			return OutputData[0];
		return OutputData.join(``);
	}
	
	const Output = {};
	Output.ExitCode = ExitCode;
	Output.StdOut = GetNiceOutput(StdOut);
	Output.StdErr = GetNiceOutput(StdErr);
	
	//	put stdout together and return it
	//console.log(`Process output; ${JSON.stringify(Output)}`);
	return Output;
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
	
	let ArchiveFilename = AppFilename;
	
	if ( TestFlightPlatform == PlaformMacos )
	{
		//	gr: needs to be nuanced than this i think
		//		but it will always need to be packaged for upload
		if ( SignApp )
		{
			await ModifyMacApp(AppFilename);
			await SignApp(AppFilename);
			const PackageFilename = await PackageApp(AppFilename);
			ArchiveFilename = PackageFilename;
		}
	}
	
	await VerifyArchive(ArchiveFilename);
	await UploadArchive(ArchiveFilename);
}

//  if this throws, set a github action error
run().catch( e => core.setFailed(`${e}`) );
