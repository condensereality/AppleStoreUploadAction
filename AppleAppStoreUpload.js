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

const PlatformMacos = 'macos';
const PlatformIos = 'ios';
const PlatformTvos = 'tvos';
const SigningCertificateName = `Apple Distribution`;

async function DecodeBase64Param(Param)
{
	const Value64 = GetParam(Param);
	
	//	gr: javascript's btoa and the unix tool base64 have differing encodings (javascript decodes to ascii, not unicode)
	//	gr: https://stackoverflow.com/questions/30106476/using-javascripts-atob-to-decode-base64-doesnt-properly-decode-utf-8-strings
	//const ValueBinary = atob(Value64);
	//	node's version is okay
	//	other backup: use shell base64 to decode back
	const ValueBinary = new Buffer(Value64, 'base64');
	
	return ValueBinary;
}


//	returns false if not found
function FindTextAroundString(Haystack,Needle,CharsBefore=10,CharsAfter=90)
{
	const FoundPosition = Haystack.search(Needle);
	if ( FoundPosition < 0 )
		return false;
	
	const TextStart = Math.max( 0, FoundPosition-CharsBefore );
	let TextLine = Haystack.substr( TextStart );

	//	stop at . or linefeed if it exists
	let TextEnd = TextLine.search('\n');
	if ( TextEnd > 0 )
		TextLine = TextLine.substr( 0, TextEnd );
	//	cap regardless
	TextLine = TextLine.substr( 0, CharsAfter );
	return TextLine;
}

function CreatePromise()
{
	let Prom = {};
	function RunPromise(Resolve,Reject)
	{
		Prom.Resolve = Resolve;
		Prom.Reject = Reject;
	}
	Prom.Promise = new Promise(RunPromise);
	let OutProm = Prom.Promise;
	OutProm.Resolve = Prom.Resolve;
	OutProm.Reject = Prom.Reject;
	return OutProm;
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
		const ReportStdError = StdErr.join(`\n`);
		if ( ThrowOnNonZeroExitCode )
			throw `Process exit code ${ExitCode}; stdout=${StdOut} stderr=${ReportStdError}`;
		//console.warn(`Process exit code ${ExitCode}; stdout=${StdOut} stderr=${ReportStdError}`);
	}
	
	//	turn arrays into something slightly easier to use (a string or null)
	function GetNiceOutput(OutputData)
	{
		if ( OutputData.length == 0 )
			return null;
		if ( OutputData.length == 1 )
			return OutputData[0];
		
		//	gr: if it's really long, dont join
		return OutputData;
		//return OutputData.join(``);
	}
	
	const Output = {};
	Output.ExitCode = ExitCode;
	Output.StdOut = GetNiceOutput(StdOut);
	Output.StdErr = GetNiceOutput(StdErr);
	
	//	put stdout together and return it
	//console.log(`Process output; ${JSON.stringify(Output)}`);
	return Output;
}


async function WriteFile(Filename,Contents)
{
	console.log(`WriteFile(${Filename}, ${typeof Contents}`);
	await FileSystem.writeFile( Filename, Contents );
}


function EscapePlistKey(Key)
{
	//	keys need to have .'s escaped
	//	https://apple.stackexchange.com/a/434727/75048
	Key = Key.split('.').join('\\.');
	//	gr: don't put these in quotes, because they appear in the plist in quotes!
	return `${Key}`;
}

async function ReadPlistKey(PlistFilename,Key,Type='string')
{
	//	errors with "CFBundleIdentifier"
	//	maybe if not escaped, or no .'s, then dont put in quotes
	//Key = EscapePlistKey(Key);
	const Command =
	[
		`plutil`,
		`-extract`,
		Key,
		`raw`,
		`-expect`,
		Type,
		PlistFilename
	];
	const Result = await RunShellCommand(Command);
	return Result.StdOut;
}

async function WritePlistChange(PlistFilename,Key,Type,Value)
{
	Key = EscapePlistKey(Key);
	const Command =
	[
		`plutil`,
		`-replace`,
		Key,
		`-${Type}`,
		Value,
		PlistFilename
	];
	await RunShellCommand(Command);
}

async function ModifyMacAppForTestFlightAndStore(AppFilename)
{
	const PlistFilename = `${AppFilename}/Contents/Info.plist`;
	console.log("Set info.plist to say there are no prohibited encryption methods...");
	await WritePlistChange(PlistFilename,'ITSAppUsesNonExemptEncryption','bool','NO');
	
	const BundleVersion = GetParam('BundleVersion',false);
	if ( BundleVersion !== false )
	{
		console.log(`Writing new Bundle version ${BundleVersion}...`);
		await WritePlistChange(PlistFilename,'CFBundleVersion','string',BundleVersion);
	}
	
	//	testflight will not allow you to release a build to external testers if it considers it built with a "beta" xcode
	console.log(`Writing "non-beta-xcode" keys to info.plist...`);
	//	a beta xcode is also detected if it has NO xcode meta!
	//	so force it in (gr: could check if its present first)
	//	gr: these values generated from a new empty xcode project, september 2023.
	//		they will probably need updating in future
	await WritePlistChange(PlistFilename,'DTXcode','string','1430');
	await WritePlistChange(PlistFilename,'DTXcodeBuild','string','14E222b');
	await WritePlistChange(PlistFilename,'DTPlatformVersion','string','13.3');
	await WritePlistChange(PlistFilename,'DTSDKBuild','string','22E245');
	
	//	the above is all that's required for "not beta", but without the following, not all entitlements work! (network client code would get blocked)
	await WritePlistChange(PlistFilename,'DTCompiler','string','com.apple.compilers.llvm.clang.1_0');
	await WritePlistChange(PlistFilename,'DTPlatformBuild','string','');
	await WritePlistChange(PlistFilename,'DTPlatformName','string','macosx');
	await WritePlistChange(PlistFilename,'DTSDKName','string','macosx13.3');

	console.log("Copy provisioning profile into app...");
	const ProvisioningProfileFilename = `${AppFilename}/Contents/embedded.provisionprofile`;
	const ProvisioningProfileContents = await DecodeBase64Param('ProvisioningProfile_Base64');
	await WriteFile(ProvisioningProfileFilename,ProvisioningProfileContents);
}


async function GetAppBundleId(AppFilename)
{
	//	read bundle id from plist
	const PlistFilename = `${AppFilename}/Contents/Info.plist`;
	const BundleId = await ReadPlistKey( PlistFilename, 'CFBundleIdentifier' );
	return BundleId;
}

//	this may be provided by user in future
async function GetEntitlementsFilename(AppFilename)
{
	const Filename = `./Entitlements.plist`;
	
	//	gr: can we extract team identifier from plist?
	const TeamIdentifier = GetParam('TeamIdentifier');
	const AppBundleId = await GetAppBundleId(AppFilename);
	const ApplicationIdentifier = `${TeamIdentifier}.${AppBundleId}`;

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


async function InstallSigningCertificate()
{
	console.log(`Listing existing identities for codesigning...`);
	//	todo: don't need to install a certificate that's already present
	const FindIdentityOutput = await RunShellCommand(`security find-identity -p codesigning -v`);
	
	const ExistingSigningCertificate = FindTextAroundString( FindIdentityOutput.StdOut, SigningCertificateName );
	const FoundSigningCertificate = ExistingSigningCertificate != false;
	
	//	if user didn't provide a signing certificate, and we find one, we'll (hopefully) use that
	const UserProvidedCertificate = GetParam('SigningCertificate_Base64',false)!=false;
	if ( !UserProvidedCertificate )
	{
		if ( FoundSigningCertificate )
		{
			console.log(`Found existing signing certificate for ${SigningCertificateName}... ${ExistingSigningCertificate}`);
			return;
		}
	}
	
	//	Apple Distribution
	console.log(FindIdentityOutput.StdOut);

	console.log(`Installing signing certificate(for ${SigningCertificateName})...`);
	const SigningCertificateFilename = `./SigningCertificate.cer`;
	const SigningCertificateContents = await DecodeBase64Param('SigningCertificate_Base64');
	//await WriteFile(ProvisioningProfileFilename,ProvisioningProfileContents);
	throw `install certificate`;
}

//	specified macos here as we insert entitlements
async function CodeSignMacosApp(AppFilename)
{
	//	https://developer.apple.com/forums/thread/129980 "--deep considered harmful"
	console.log(`[re-]sign dylibs inside, without entitlements...`);
	//	gr: need to keep stuff in quotes in one arg
	const CodesignDylibsArgs =
	[
		`codesign`,
		`--force`,
		`--sign`,
		SigningCertificateName,
		`--deep`,
		AppFilename,
	];
	await RunShellCommand(CodesignDylibsArgs);

	const EntitlementsFilename = await GetEntitlementsFilename(AppFilename);
	console.log(`re-sign app only & embed entitlements...`);
	const CodesignAppArgs =
	[
		`codesign`,
		`--force`,
		`--entitlements`,
		EntitlementsFilename,
		`--sign`,
		SigningCertificateName,
		AppFilename,
	];
	await RunShellCommand(CodesignAppArgs);

	//	gr: codesign -d --entitlements :- Studio5.app/Contents/Frameworks/UnityPlayer.dylib should list NO ENTITLEMENTS
	//	gr: codesign -d --entitlements :- Studio5.app SHOULD have entitlements
}

async function PackageApp(AppFilename)
{
	const PackageFilename = `${AppFilename}.pkg`;
	console.log(`Put ${AppFilename} into package ${PackageFilename}...`);
	await RunShellCommand(`xcrun productbuild --component ${AppFilename} /Applications ${PackageFilename}`);
	
	//	eg. AA1A111A1
	//	unfortunately cant use "3rd Party Mac Developer Installer"
	//	but, the ID of the certificate gets matched when it's the team ID!
	const SignPackage = GetParam("SignPackage",true);
	if ( !SignPackage )
	{
		return PackageFilename;
	}
	
	const TeamIdentifier = GetParam('TeamIdentifier');
	const InstallerCertificateId = TeamIdentifier;
	
	const SignedPackageFilename = `${AppFilename}.signed.pkg`;
	console.log(`Sign .pkg into ${SignedPackageFilename} with ${InstallerCertificateId}... ${PackageFilename} ${SignedPackageFilename}`);
	await RunShellCommand(`productsign --sign ${InstallerCertificateId} ${PackageFilename} ${SignedPackageFilename}`);
	return SignedPackageFilename;
}


async function UploadArchive(ArchiveFilename,VerifyOnly=false)
{
	const Function = VerifyOnly ? `validate-app` : `upload-app`;
	
	const TestFlightPlatform = GetParam('TestFlightPlatform');

	//	gr: pre-empt obscure errors
	if ( TestFlightPlatform == PlatformMacos )
	{
		//	if a .app is uploaded, then it will error that it cannot find plist/bundle identifier
		const AllowedExtensions = ['.pkg'];
		const MatchingExtensions = AllowedExtensions.filter( Ext => ArchiveFilename.toLowerCase().endsWith(Ext) );
		if ( MatchingExtensions.length == 0 )
			throw `Platform ${TestFlightPlatform} archive filename(${ArchiveFilename}) must end with one of ${AllowedExtensions}`;
	}

	const ApiKey = GetParam('AppStoreConnect_Auth_Key');
	const ApiIssuer = GetParam('AppStoreConnect_Auth_Issuer');

	if ( VerifyOnly )
		console.log(`Validate final package  ${ArchiveFilename} for upload...`);
	else
		console.log(`Uploading package ${ArchiveFilename}...`);

	//	gr: this process has a LOT of output
	//		so catch it and try and find all errors
	const FailOnExitCode = false;
	const RunResult = await RunShellCommand(`xcrun altool --${Function} --file ${ArchiveFilename} --type ${TestFlightPlatform} --apiKey ${ApiKey} --apiIssuer ${ApiIssuer}`, FailOnExitCode);
	
	if ( RunResult.ExitCode != 0 )
	{
		const ErrorKeyword = 'rror';

		//	todo: handle multiple "error" in one line
		function ExtractErrorMessage(Line)
		{
			return FindTextAroundString( Line, ErrorKeyword, 10, 300 );
		}

		//	some giant stderr lines (json) so join all together, then split again to get individual lines
		let ErrorLines = RunResult.StdErr.join("\n");
		ErrorLines = ErrorLines.split("\n");
		ErrorLines = ErrorLines.map( ExtractErrorMessage );
		ErrorLines = ErrorLines.filter( e => e!=false );

		console.error(`Error messages found...\n${ErrorLines.join("\n")}`);
		throw `${Function} failed with exit code ${RunResult.ExitCode}`;
	}
	
	//	output the resulting info
	console.log(`${Function} succeeded; ${RunResult.StdOut}`);
	console.log(`stderr: ${RunResult.StdErr}`);
}

async function VerifyArchive(ArchiveFilename)
{
	return await UploadArchive( ArchiveFilename, true );
}


async function run() 
{
	//	grab required params
	const AppFilename = GetParam('AppFilename');
	const TestFlightPlatform = GetParam('TestFlightPlatform');
	
	let ArchiveFilename = AppFilename;
	
	if ( TestFlightPlatform == PlatformMacos )
	{
		const SignApp = GetParam('SignApp',true);
		//	gr: needs to be nuanced than this i think
		//		but it will always need to be packaged for upload
		if ( SignApp )
		{
			await ModifyMacAppForTestFlightAndStore(AppFilename);
			await InstallSigningCertificate();
			await CodeSignMacosApp(AppFilename);
		}

		const PackageFilename = await PackageApp(AppFilename);
		ArchiveFilename = PackageFilename;
	}
	
	await VerifyArchive(ArchiveFilename);
				
	//	by default we upload, but user can avoid it
	const DoUpload = GetParam('Upload',true);
	if ( DoUpload )
	{
		await UploadArchive(ArchiveFilename);
	}
}

//  if this throws, set a github action error
run().catch( e => core.setFailed(`${e}`) );
