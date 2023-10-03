import * as core from "@actions/core"
import * as github from "@actions/github"
import * as artifact from "@actions/artifact"
import * as os from "os"
import * as FileSystem from "fs/promises"
import * as Path from "path"
import { spawn } from "child_process";
import { exec } from "child_process";
//import * as Url from "url"

//	no __dirname or __filename in module-js node
//const __dirname = Url.fileURLToPath(new URL('.', import.meta.url));

import { GetParam } from './Params.js'

const PlatformMacos = 'macos';
const PlatformIos = 'ios';
const PlatformTvos = 'tvos';
const SigningCertificateName = `Apple Distribution`;

//	gr: ./ instead of just name... makes a difference! It seems to make identities valid!(once CSA is installed)
const SigningKeychainName = `./SigningKeychain.keychain`;
//const SigningKeychainName = null;
const SigningKeychainPassword = `password`;

const AppleCertificateAuthorityUrl = `https://www.apple.com/certificateauthority/AppleWWDRCAG3.cer`;


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
	
	//	spawn() creates a new process
	//	exec() runs in same process/shell (so security-unlock states remain!)
	const NewProcess = false;
	if ( NewProcess )
	{
		//console.log(`Running process [${Exe}], args=${Arguments}...`);
		//	shell breaks arguments, not getting passed to the exe...
		//const Process = spawn( Exe, Arguments, {shell:true} );
		const Process = spawn( Exe, Arguments );
		
		Process.on('error',OnError);
		Process.stdout.on('data',OnStdOut);
		Process.stderr.on('data',OnStdErr);
		Process.on("close",OnProcessExit);
	}
	else
	{
		{
			function OnExecFinished(exit,out,err)
			{
				//console.log(`OnExecFinished(${exit},${out},${err})`);
				OnStdOut(out);
				OnStdErr(err);
				ProcessPromise.Resolve(exit||0);
			}
			const Cmd = `${Exe} ${Arguments.join(' ')}`;
			exec( Cmd, OnExecFinished );
		}
	}
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
	
	//	make directory
	const FileDir = Path.dirname(Filename);
	//if ( !await FileSystem.exists(FileDir) )
	{
		await FileSystem.mkdir( FileDir, { recursive: true });
	}
	
	await FileSystem.writeFile( Filename, Contents );
}


function EscapePlistKey(Key)
{
	//	keys need to have .'s escaped
	//	https://apple.stackexchange.com/a/434727/75048
	Key = Key.split('.').join('\\.');
	//	gr: don't put these in quotes, because they appear in the plist in quotes!
	//	gr: need to be in quotes for exec() but not spawn()!
	return `"${Key}"`;
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
	await WritePlistChange(PlistFilename,'DTPlatformBuild','string','""');
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
	
	//	gr: make these param options! I dont want server, but temporarily needed to re-add it
	await WritePlistChange( Filename, `com.apple.security.network.client`, 'bool','YES' );
	await WritePlistChange( Filename, `com.apple.security.network.server`, 'bool','YES' );

	//	need to insert team & app identifiers to match with provision file
	await WritePlistChange( Filename, `com.apple.application-identifier`, 'string', ApplicationIdentifier );
	await WritePlistChange( Filename, `com.apple.developer.team-identifier`, 'string', TeamIdentifier );

	return Filename;
}


async function FindSigningIdentity(KeychainName)
{
	console.log(`Listing identities for codesigning...`);
	//	todo: don't need to install a certificate that's already present
	//	-v to only show valid (without, shows invalid too)
	//const FindIdentityOutput = await RunShellCommand(`security find-identity -p codesigning ${KeychainName}`);
	const FindIdentityOutput = await RunShellCommand(`security find-identity ${KeychainName}`);

	const ExistingSigningCertificate = FindTextAroundString( FindIdentityOutput.StdOut, SigningCertificateName );

	//	Apple Distribution
	console.log(FindIdentityOutput.StdOut);

	return ExistingSigningCertificate;
}

//	return name of keychain
async function CreateKeychain(KeychainName,KeychainPassword)
{
	if ( !KeychainName )
		return null;
	
	//	delete old keychain
	try
	{
		console.log(`Deleting old security keychain ${KeychainName}`);
		await RunShellCommand(`security delete-keychain ${KeychainName}`);
	}
	catch(e)
	{
		console.log(`Error deleting old keychain; ${e}`);
	}
	
	
	//	create a keychain
	console.log(`Creating keychain ${KeychainName}...`);
	const CreateKeychain =
	[
	 `security`,
	 `create-keychain`,
	 `-p`,
	 KeychainPassword,
	 KeychainName
	];
	await RunShellCommand(CreateKeychain);
	
	const Meta = {};
	Meta.Name = KeychainName;
	Meta.Password = KeychainPassword;
	return Meta;
}


async function InstallCertificateFile(Filename,Keychain,CertificatePassword)
{
	//		-x  Specify that private keys are non-extractable after being imported
	//		-A allows any app to use this certificate (insecure)
	//	only short hand input args work! (dont believe the --help)
	//	filenames error if in quotes
	const InstallCertificateCommand =
	[
	 `security`,
	 `import`,
	 Filename,
	 `-T`,	//	instead of -A ll, allow specific access
	 `/usr/bin/codesign`,
	 `-t`,	//	type (cert)
	 `cert`,
	 `-A`,	//	Allow any app to use certificate
	];
	if ( CertificatePassword )
	{
		//	gr: format prompts for password, even for apple one. do we need it?
		//	-format p12
		InstallCertificateCommand.push(`-f`,`pkcs12`);
		InstallCertificateCommand.push(`-P`, CertificatePassword );
	}
	
	if ( Keychain )
	{
		InstallCertificateCommand.push(`-k`,Keychain.Name);
	}
	
	//set -o pipefail && security import ${{ env.CertificateFilePath }} -P "${{ secrets.AppSigningCertificate_Password }}" -A -t cert -f pkcs12
	console.log( InstallCertificateCommand.join(` `) );
	await RunShellCommand(InstallCertificateCommand);
}


async function InstallSigningCertificate()
{
	const Keychain = await CreateKeychain(SigningKeychainName,SigningKeychainPassword);
	
	//	gr: this (unlock) seems to help things being valid
	if ( Keychain )
	{
		await SwitchKeychain( Keychain.Name, Keychain.Password );
	}
	
	const ExistingSigningCertificate = await FindSigningIdentity(Keychain?Keychain.Name:null);

	//	if user didn't provide a signing certificate, and we find one, we'll (hopefully) use that
	const UserProvidedCertificate = GetParam('SigningCertificate_Base64',false)!=false;
	if ( !UserProvidedCertificate )
	{
		if ( ExistingSigningCertificate )
		{
			console.log(`Found existing signing certificate for ${SigningCertificateName}... ${ExistingSigningCertificate}`);
			return;
		}
	}
	
	//	gr; not sure why this errors when instlaling to default keychain
	if ( Keychain )
	{
		//	if we've made a new keychain, it'll be missing a certificate authority
		//	so all certificates will be not-trusted (and invalid for code signing)
		//	so install the apple csa
		//fetch
		//https://www.apple.com/certificateauthority/AppleWWDRCAG3.cer
		const AppleCsaFilename = `./AppleWWDRCAG3.cer`;
		console.log(`Installing Apple CSA certificate ${AppleCsaFilename} to ${Keychain?Keychain.Name:null}...`);
		await InstallCertificateFile( AppleCsaFilename, Keychain );
	}
	
	console.log(`Creating signing certificate file to install(for ${SigningCertificateName})...`);
	const SigningCertificatePassword = GetParam('SigningCertificate_Password');
	const SigningCertificateFilename = `./SigningCertificate.cer.p12`;
	const SigningCertificateContents = await DecodeBase64Param('SigningCertificate_Base64');
	await WriteFile(SigningCertificateFilename,SigningCertificateContents);
	
	console.log(`Installing signing certificate(for ${SigningCertificateName} to ${Keychain?Keychain.Name:null})...`);
	await InstallCertificateFile( SigningCertificateFilename, Keychain, SigningCertificatePassword );

	//	re-find identity to make sure it was installed
	const NewFoundIdentity = await FindSigningIdentity(Keychain?Keychain.Name:null);
	console.log(`Post-install certificate found; ${NewFoundIdentity}`);
	
	const SigningMeta = {};
	if ( Keychain )
	{
		SigningMeta.KeychainName = Keychain.Name;
		SigningMeta.KeychainPassword = Keychain.Password;
	}
	return SigningMeta;
}

async function SwitchKeychain(KeychainName,KeychainPassword,SetPartition)
{
	const ListOutput = await RunShellCommand(`security list-keychains -s ${KeychainName}`);
	console.log(ListOutput.StdOut||ListOutput.StdErr);

	//	gr: dont set default, but unlock
	//console.log(`Switching default keychain to ${KeychainName}...`);
	//const SetDefaultOutput = await RunShellCommand(`security default-keychain -s ${KeychainName}`);
	//console.log(SetDefaultOutput.StdOut||SetDefaultOutput.StdErr);

	//	unlocking keychain makes it appear in KeyChain Access!
	//	gr: unlocking keychain with wrong password, gives no error
	console.log(`Unlocking keychain ${KeychainName} with [${KeychainPassword}]...`);
	const UnlockOutput = await RunShellCommand(`security unlock-keychain -p ${KeychainPassword} ${KeychainName}`);
	console.log(UnlockOutput.StdOut||UnlockOutput.StdErr);

	//	gr: this only works AFTER importing something!
	if ( SetPartition )
	{
		//	https://developer.apple.com/forums/thread/712005
		//	Finally, modify set the partition list to allow access by Apple code:
		//	security set-key-partition-list -S "apple:" -l "Apple Distribution: …"
		
		//	https://github.com/NewChromantics/import-signing-certificate/blob/main/index.js
		//const SetKeyPartitionOutput = await RunShellCommand(`security set-key-partition-list -S apple-tool:,apple: -s -k ${KeychainPassword} ${KeychainName}`);
		//const SetKeyPartitionOutput = await RunShellCommand(`security set-key-partition-list -S "apple:" -l "${SigningCertificateName}" -k ${KeychainPassword} ${KeychainName}`);
		const SetKeyPartitionOutput = await RunShellCommand(`security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "${KeychainPassword}" "${KeychainName}"`);
		//	https://stackoverflow.com/questions/39868578/security-codesign-in-sierra-keychain-ignores-access-control-settings-and-ui-p
		//const SetKeyPartitionOutput = await RunShellCommand(`security set-key-partition-list -S apple-tool:,apple: -s -k ${KeychainPassword} ${KeychainName}`);
		console.log(SetKeyPartitionOutput.StdOut||SetKeyPartitionOutput.StdErr);
	}
 }

async function Yield(ms)
{
	const Prom = new Promise( resolve => setTimeout( resolve, ms ) );
	await Prom;
}

//	specified macos here as we insert entitlements
async function CodeSignMacosApp(AppFilename,SigningMeta)
{
	if ( SigningMeta.KeychainName )
	{
		//	unlocking keychain makes it appear in KeyChain Access!
		await SwitchKeychain( SigningMeta.KeychainName, SigningMeta.KeychainPassword, true );
	}
	
	try
	{
		//await RunShellCommand(`security default-keychain -s ${SigningMeta.KeychainName}`);
		
		//	https://developer.apple.com/forums/thread/129980 "--deep considered harmful"
		console.log(`[re-]sign dylibs inside, without entitlements...`);
		//	todo: need to make this fail if it requests keychain access/sudo/user prompt
		const CodesignDylibsArgs =
		[
			//`security unlock-keychain -p ${SigningMeta.KeychainPassword} ${SigningMeta.KeychainName} &&`,
			`codesign`,
			`--force`,
			//`--keychain`,
			//SigningMeta.KeychainName,
			`--sign`,
			`"${SigningCertificateName}"`,
			`--deep`,
			AppFilename,
		];
		await RunShellCommand(CodesignDylibsArgs);
		
		console.log(`Generating entitlements file...`);
		const EntitlementsFilename = await GetEntitlementsFilename(AppFilename);
		
		console.log(`re-sign app only & embed entitlements...`);
		const CodesignAppArgs =
		[
			//`set -o pipeline`,	//	gr: we can't insert this everywhere, but it works for codesign, to abort if user prompts appear
			`codesign`,
			`--force`,
			//`--keychain`,
			//Keychain.Name,
			`--entitlements`,
			EntitlementsFilename,
			`--sign`,
			SigningCertificateName,
			AppFilename,
		];
		await RunShellCommand(CodesignAppArgs);
	}
	finally
	{
		//console.log(`Restoring default keychain`);
		//await RunShellCommand(`security default-keychain -s login.keychain`);
	}

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


async function InstallAppStoreConnectAuth()
{
	const AuthKey = GetParam('AppStoreConnect_Auth_Key');
	
	//	gr: probably shouldn't install to cwd...
	//	gr: this file is explicitl AuthKey_KeyId
	const AuthKeyFilename = `./private_keys/AuthKey_${AuthKey}.p8`;
	console.log(`Decoding .p8 auth file to ${AuthKeyFilename}...`);

	const AuthKeyContents = await DecodeBase64Param('AppStoreConnect_Auth_P8_Base64');
	await WriteFile(AuthKeyFilename,AuthKeyContents);
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
	//	gr: there's tons of output, only show the tail end
	console.log(`${Function} succeeded; ${RunResult.StdOut}`);
	//console.log(`stderr: ${RunResult.StdErr}`);
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
			const SigningMeta = await InstallSigningCertificate();
			await CodeSignMacosApp( AppFilename, SigningMeta );
		}

		const PackageFilename = await PackageApp(AppFilename);
		ArchiveFilename = PackageFilename;
	}
	
	await InstallAppStoreConnectAuth();
	await VerifyArchive(ArchiveFilename);
				
	//	by default we upload, but user can avoid it
	const DoUpload = GetParam('Upload',true);
	if ( DoUpload )
	{
		await UploadArchive(ArchiveFilename);
	}
	else
	{
		console.log(`Skipping package upload`);
	}
}

//  if this throws, set a github action error
run().catch( e => core.setFailed(`${e}`) );
