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
const PlatformTvos = 'appletvos';
const SigningCertificateName = `Apple Distribution`;
const InstallerCertificateName = `3rd Party Mac Developer Installer`;

//	gr: ./ instead of just name... makes a difference! It seems to make identities valid!(once CSA is installed)
const SigningKeychainName = `./SigningKeychain.keychain`;
//const SigningKeychainName = null;
const SigningKeychainPassword = `password`;
//	if user doesn't provide Keychain (where they can use false to disable it), it will use this
const DefaultSigningKeychainName = SigningKeychainName;

//	authority for signing identity
const AppleCertificateAuthorityUrl = `https://www.apple.com/certificateauthority/AppleWWDRCAG3.cer`;

//	authority for installer identity
//	https://developer.apple.com/news/?id=5zb13auf#:~:text=Apple%20Developer%20ID%20Intermediate%20Certificate,expires%20on%20September%2016%2C%202031.
const AppleInstallerCertificateAuthorityUrl = `https://www.apple.com/certificateauthority/DeveloperIDG2CA.cer`;

const AppleRootCertificateAuthorityUrl = `https://www.apple.com/certificateauthority/AppleRootCA-G2.cer`;



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
//	gr: some calls are producing incorrect results with the argument escaping, some dont. Need to figure this out
//		macos calls for certificates don't want to be escaped, ios/tvos ones did
async function RunShellCommand(ExeAndArguments,EscapeArguments=true,ThrowOnNonZeroExitCode=true)
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
			function OnExecFinished(exiterror,out,err)
			{
				let ExitCode;
				if ( exiterror == null )
				{
					ExitCode = 0;
				}
				else
				{
					//	gr: exiterror is an instead of Error object
					//		to keep in sync with spawn() we want to resolve the promise to an error code
					ExitCode = exiterror.code || 1;
				}
				//console.log(`OnExecFinished(${exit},${out},${err})`);
				OnStdOut(out);
				OnStdErr(err);
				ProcessPromise.Resolve(ExitCode);
			}
			
			function GetCmdEscaped()
			{
				function EscapeArg(Argument)
				{
					return Argument.replace(' ','\\ ');
				}
				let EscapedArguments = Arguments.map(EscapeArg);
				return `${Exe} ${EscapedArguments.join(' ')}`;
			}
			function GetCmdNotEscaped()
			{
				return `${Exe} ${Arguments.join(' ')}`;
			}
			
			const Cmd = EscapeArguments ? GetCmdEscaped() : GetCmdNotEscaped();
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
		
	const Output = {};
	Output.ExitCode = ExitCode;
	Output.StdOut = StdOut;
	Output.StdErr = StdErr;
	
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
	console.log(`Read plist; ${Command.join(' ')}`);
	const Result = await RunShellCommand(Command);

	//	gr: for uuid extraction, this was returning a list of 1 result...
	if ( Array.isArray(Result.StdOut) )
		if ( Result.StdOut.length == 1 )
			return Result.StdOut[0];
	
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
	console.log(`Write plist; ${Command.join(' ')}`);
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
	const IdentifierKey = 'CFBundleIdentifier';
	const BundleId = await ReadPlistKey( PlistFilename, IdentifierKey );
	return BundleId;
}

async function GetArchiveBundleId(ArchiveFilename)
{
	//	read bundle id from plist
	const PlistFilename = `${ArchiveFilename}/Info.plist`;
	const IdentifierKey = 'ApplicationProperties.CFBundleIdentifier';
	const BundleId = await ReadPlistKey( PlistFilename, IdentifierKey );
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


async function FindSigningIdentity(KeychainName,CertificateName)
{
	console.log(`Listing identities for codesigning...`);
	//	todo: don't need to install a certificate that's already present
	//	-v to only show valid (without, shows invalid too)
	//const FindIdentityOutput = await RunShellCommand(`security -v find-identity -p codesigning ${KeychainName}`);
	const FindIdentityOutput = await RunShellCommand(`security -v find-identity ${KeychainName}`);

	const ExistingSigningCertificate = FindTextAroundString( FindIdentityOutput.StdOut.join(``), CertificateName );

	//	Apple Distribution
	console.log(FindIdentityOutput.StdOut);

	return ExistingSigningCertificate;
}

//	return name of keychain
async function CreateKeychain()
{
	let KeychainName = GetParam('Keychain', DefaultSigningKeychainName );
	let KeychainPassword = SigningKeychainPassword;
	
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
	const Keychain = await CreateKeychain();
	
	//	gr: this (unlock) seems to help things being valid
	if ( Keychain )
	{
		await SwitchKeychain( Keychain );
	}
	
	const ExistingSigningCertificate = await FindSigningIdentity(Keychain?Keychain.Name:null, SigningCertificateName);

	//	if user didn't provide a signing certificate, and we find one, we'll (hopefully) use that
	const UserProvidedCertificate = GetParam('SigningCertificate_P12_Base64',false)!=false;
	if ( !UserProvidedCertificate )
	{
		if ( ExistingSigningCertificate )
		{
			console.log(`Found existing signing certificate for ${SigningCertificateName}... ${ExistingSigningCertificate}`);
			return;
		}
	}
	
	//	gr; not sure why this errors when instlaling to default keychain, so only run if we are using a keychain
	if ( Keychain )
	{
		await InstallSigningAuthorityCertificate(Keychain);
	}
	
	console.log(`Creating signing certificate file to install(for ${SigningCertificateName})...`);
	const SigningCertificatePassword = GetParam('SigningCertificate_Password');
	const SigningCertificateFilename = `./SigningCertificate.cer.p12`;
	const SigningCertificateContents = await DecodeBase64Param('SigningCertificate_P12_Base64');
	await WriteFile(SigningCertificateFilename,SigningCertificateContents);
	
	console.log(`Installing signing certificate(for ${SigningCertificateName} to ${Keychain?Keychain.Name:null})...`);
	await InstallCertificateFile( SigningCertificateFilename, Keychain, SigningCertificatePassword );

	//	re-find identity to make sure it was installed
	const NewFoundIdentity = await FindSigningIdentity(Keychain?Keychain.Name:null, SigningCertificateName);
	console.log(`Post-install certificate found; ${NewFoundIdentity}`);
	
	return Keychain;
}


async function InstallSigningAuthorityCertificate(Keychain)
{
	//	if we've made a new keychain, it'll be missing a certificate authority
	//	so all certificates will be not-trusted (and invalid for code signing)
	//	so install the apple csa
	const Response = await fetch(AppleCertificateAuthorityUrl);
	if ( !Response.ok )
		throw `Failed to download AppleCertificateAuthority certificate ${AppleCertificateAuthorityUrl}; ${Response.status}`;
	let AppleCsaContents = await Response.arrayBuffer();
	AppleCsaContents = Buffer.from(AppleCsaContents);
	const AppleCsaFilename = `./AppleWWDRCAG3.cer`;
	await WriteFile(AppleCsaFilename,AppleCsaContents);
	console.log(`Installing Apple CSA certificate ${AppleCsaFilename} to ${Keychain?Keychain.Name:null}...`);
	await InstallCertificateFile( AppleCsaFilename, Keychain );
}

async function InstallInstallerAuthorityCertificate(Keychain)
{
	const Response = await fetch(AppleInstallerCertificateAuthorityUrl);
	if ( !Response.ok )
		throw `Failed to download AppleInstallerCertificateAuthorityUrl certificate ${AppleCertificateAuthorityUrl}; ${Response.status}`;
	let AppleCsaContents = await Response.arrayBuffer();
	AppleCsaContents = Buffer.from(AppleCsaContents);
	const AppleCsaFilename = `./DeveloperIDG2CA.cer`;
	await WriteFile(AppleCsaFilename,AppleCsaContents);
	console.log(`Installing Apple developer g2 CSA certificate ${AppleCsaFilename} to ${Keychain?Keychain.Name:null}...`);
	await InstallCertificateFile( AppleCsaFilename, Keychain );
}

async function InstallRootAuthorityCertificate(Keychain)
{
	const Response = await fetch(AppleRootCertificateAuthorityUrl);
	if ( !Response.ok )
		throw `Failed to download AppleRootCertificateAuthorityUrl certificate ${AppleCertificateAuthorityUrl}; ${Response.status}`;
	let AppleCsaContents = await Response.arrayBuffer();
	AppleCsaContents = Buffer.from(AppleCsaContents);
	const AppleCsaFilename = `./AppleRootCA-G2.cer`;
	await WriteFile(AppleCsaFilename,AppleCsaContents);
	console.log(`Installing Apple root certificate ${AppleCsaFilename} to ${Keychain?Keychain.Name:null}...`);
	await InstallCertificateFile( AppleCsaFilename, Keychain );
}

async function InstallInstallerCertificate(Keychain)
{
	//	if user didn't provide a signing certificate, and we find one, we'll (hopefully) use that
	const UserProvidedCertificate = GetParam('InstallerCertificate_P12_Base64',false)!=false;
	/*
	 if ( !UserProvidedCertificate )
	 {
	 if ( ExistingSigningCertificate )
	 {
	 console.log(`Found existing signing certificate for ${SigningCertificateName}... ${ExistingSigningCertificate}`);
	 return;
	 }
	 }
	 */
	console.log(`Creating install certificate file to install(for ${InstallerCertificateName})...`);
	const InstallerCertificatePassword = GetParam('InstallerCertificate_Password');
	const InstallerCertificateFilename = `./InstallerCertificate.cer`;
	const InstallerCertificateContents = await DecodeBase64Param('InstallerCertificate_P12_Base64');
	await WriteFile(InstallerCertificateFilename,InstallerCertificateContents);
	
	console.log(`Installing installer certificate(for ${InstallerCertificateName} to ${Keychain?Keychain.Name:null})...`);
	await InstallCertificateFile( InstallerCertificateFilename, Keychain, InstallerCertificatePassword );
	
	const FoundIdentity = await FindSigningIdentity(Keychain?Keychain.Name:null, InstallerCertificateName);
}

async function SwitchKeychain(Keychain,SetPartition)
{
	const ListOutput = await RunShellCommand(`security list-keychains -s ${Keychain.Name}`);
	console.log(ListOutput.StdOut||ListOutput.StdErr);

	//	gr: dont set default, but unlock
	//console.log(`Switching default keychain to ${KeychainName}...`);
	//const SetDefaultOutput = await RunShellCommand(`security default-keychain -s ${KeychainName}`);
	//console.log(SetDefaultOutput.StdOut||SetDefaultOutput.StdErr);

	//	unlocking keychain makes it appear in KeyChain Access!
	//	gr: unlocking keychain with wrong password, gives no error
	console.log(`Unlocking keychain ${Keychain.Name} with [${Keychain.Password}]...`);
	const UnlockOutput = await RunShellCommand(`security unlock-keychain -p ${Keychain.Password} ${Keychain.Name}`);
	console.log(UnlockOutput.StdOut||UnlockOutput.StdErr);

	//	this applies to *certificates*, not keychains
	//	so run it AFTER installing a certificate, to unlock it for use in the applications specified
	if ( SetPartition )
	{
		//	https://developer.apple.com/forums/thread/712005
		//	Finally, modify set the partition list to allow access by Apple code:
		//	security set-key-partition-list -S "apple:" -l "Apple Distribution: …"
		
		//	https://github.com/NewChromantics/import-signing-certificate/blob/main/index.js
		//const SetKeyPartitionOutput = await RunShellCommand(`security set-key-partition-list -S apple-tool:,apple: -s -k ${Keychain.Password} ${Keychain.Name}`);
		//const SetKeyPartitionOutput = await RunShellCommand(`security set-key-partition-list -S "apple:" -l "${SigningCertificateName}" -k ${Keychain.Password} ${Keychain.Name}`);
		//	https://stackoverflow.com/questions/39868578/security-codesign-in-sierra-keychain-ignores-access-control-settings-and-ui-p
		//const SetKeyPartitionOutput = await RunShellCommand(`security set-key-partition-list -S apple-tool:,apple: -s -k ${Keychain.Password} ${Keychain.Name}`);

		//	gr: this is working for everything! but leaving the alternatives above
		const SetKeyPartitionOutput = await RunShellCommand(`security set-key-partition-list -S apple-tool:,apple:,codesign:,productsign: -s -k "${Keychain.Password}" "${Keychain.Name}"`);
		console.log(SetKeyPartitionOutput.StdOut||SetKeyPartitionOutput.StdErr);
	}
 }

async function Yield(ms)
{
	const Prom = new Promise( resolve => setTimeout( resolve, ms ) );
	await Prom;
}

//	specified macos here as we insert entitlements
async function CodeSignMacosApp(AppFilename,Keychain)
{
	if ( Keychain )
	{
		//	unlocking keychain makes it appear in KeyChain Access!
		await SwitchKeychain( Keychain, true );
	}
	
	try
	{
		//await RunShellCommand(`security default-keychain -s ${Keychain.Name}`);
		
		//	https://developer.apple.com/forums/thread/129980 "--deep considered harmful"
		console.log(`[re-]sign dylibs inside, without entitlements...`);
		//	todo: need to make this fail if it requests keychain access/sudo/user prompt
		const CodesignDylibsArgs =
		[
			`codesign`,
			`--force`,
			//	gr: didn't seem to need keychain on github runner... as there's no ambiguity?
			//		but can't hurt to be specific
			Keychain ? `--keychain` : '',
			Keychain ? Keychain.Name : '',
			`--sign`,
			`"${SigningCertificateName}"`,
			`--deep`,
			AppFilename,
		];
		//	this broke in v0.0.2, working in v0.0.1
		const EscapeArguments = false;
		await RunShellCommand(CodesignDylibsArgs,EscapeArguments);
		
		console.log(`Generating entitlements file...`);
		const EntitlementsFilename = await GetEntitlementsFilename(AppFilename);
		
		console.log(`re-sign app only & embed entitlements...`);
		const CodesignAppArgs =
		[
			//`set -o pipeline`,	//	gr: we can't insert this everywhere, but it works for codesign, to abort if user prompts appear
			`codesign`,
			`--force`,
			Keychain ? `--keychain` : '',
			Keychain ? Keychain.Name : '',
			`--entitlements`,
			EntitlementsFilename,
			`--sign`,
			`"${SigningCertificateName}"`,
			AppFilename,
		];
		//	this broke in v0.0.2, working in v0.0.1
		await RunShellCommand(CodesignAppArgs,EscapeArguments);
	}
	finally
	{
		//console.log(`Restoring default keychain`);
		//await RunShellCommand(`security default-keychain -s login.keychain`);
	}

	//	gr: codesign -d --entitlements :- Studio5.app/Contents/Frameworks/UnityPlayer.dylib should list NO ENTITLEMENTS
	//	gr: codesign -d --entitlements :- Studio5.app SHOULD have entitlements
}

async function PackageApp(AppFilename,Keychain)
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
	
	await InstallRootAuthorityCertificate(Keychain);
	await InstallInstallerAuthorityCertificate(Keychain);
	await InstallInstallerCertificate(Keychain);
	
	//	unlock the keychain (run partition) everytime we install a certificate
	await SwitchKeychain( Keychain, true );
	
	const TeamIdentifier = GetParam('TeamIdentifier');
	const InstallerCertificateId = TeamIdentifier;
	
	const SignedPackageFilename = `${AppFilename}.signed.pkg`;
	console.log(`Sign .pkg into ${SignedPackageFilename} with ${InstallerCertificateId}(Should have a matching installer certificate)... ${PackageFilename} ${SignedPackageFilename}`);
	//	gr: this can also take --keychain xx but seems to never work
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


async function UploadArchive(ArchiveFilename,VerifyOnly=false,v001MacosMode=false)
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

	//	v0.0.2 working for ios/tvos
	let EscapeArguments = true;
	let RunCommand = [
					 `xcrun`,
					 `altool`,
					 `--${Function}`,
					 `--file`,
					 `${ArchiveFilename}`,
					 `--type`,
					 `${TestFlightPlatform}`,
					 `--apiKey`,
					 `${ApiKey}`,
					 `--apiIssuer`,
					 `${ApiIssuer}`
					 ];

	
	//	v0.0.1 working for macos
	if ( v001MacosMode )
	{
		EscapeArguments = false;
		RunCommand = `xcrun altool --${Function} --file ${ArchiveFilename} --type ${TestFlightPlatform} --apiKey ${ApiKey} --apiIssuer ${ApiIssuer}`;
	}
	
	const RunResult = await RunShellCommand(RunCommand, EscapeArguments, FailOnExitCode);
	
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

async function VerifyArchive(ArchiveFilename,v001MacosMode)
{
	return await UploadArchive( ArchiveFilename, true,v001MacosMode );
}


async function ArchiveToIpa(ArchiveFilename)
{
	//	inject provision file
	//console.log(`Copy provisioning profile into xcarchive...`);
	const ProvisioningProfileFilename = `${ArchiveFilename}/embedded.mobileprovision`;
	const ProvisioningProfileContents = await DecodeBase64Param('ProvisioningProfile_Base64');
	await WriteFile(ProvisioningProfileFilename,ProvisioningProfileContents);

	const BundleId = await GetArchiveBundleId(ArchiveFilename);

	//	generate export plist
	const ExportPlistFilename = `./Export.plist`;
	await RunShellCommand(`plutil -create xml1 ${ExportPlistFilename}`);
	await WritePlistChange( ExportPlistFilename, `method`, 'string','app-store' );
	await WritePlistChange( ExportPlistFilename, `provisioningProfiles`, 'xml',"'<dict/>'" );
	
	//	from provision file .UUID
	//	but to do that, we need to convert the provision file to something readable
	const ProvisioningProfileJsonFilename = `${ProvisioningProfileFilename}.json`;
	const ConvertResult = await RunShellCommand(`security cms -D -i ${ProvisioningProfileFilename} > ${ProvisioningProfileJsonFilename}`);
	const ProvisionUuid = await ReadPlistKey( ProvisioningProfileJsonFilename, 'UUID') ;
	//console.log(`Extracted ProvisionUuid=${ProvisionUuid} (type=${typeof ProvisionUuid})`);
	
	const DictionaryValue = {};
	DictionaryValue[BundleId] = ProvisionUuid;
	await WritePlistChange( ExportPlistFilename, `provisioningProfiles`, 'json', `'${JSON.stringify(DictionaryValue)}'` );

	
	const ExportFolder = ArchiveFilename.replace('.xcarchive','.ipaexport');
	
	const Command = 
	[
		`xcodebuild`,
		`-exportArchive`,
		`-archivePath`,
		ArchiveFilename,
		`-exportPath`,
		ExportFolder,
		`-exportOptionsPlist`,
		ExportPlistFilename
	];
	const Result = await RunShellCommand(Command);
	
	//	gr: nothing outputs the filename
	//		its from the TARGET_NAME, which becomes
	//		xyz.xcarchive/Products/Applications/Studio 5.app
	//		I presume that's where the ipa filename comes from.
	//		This app name is in the archive/Info.plist ApplicationProperties.ApplicationPath
	let ExportedFilenames = await FileSystem.readdir(ExportFolder);
	console.log(`ExportedFilenames = ${ExportedFilenames}`);

	ExportedFilenames = ExportedFilenames.filter( Filename => Filename.includes('.ipa') );
	
	let IpaFilename = `${ExportFolder}/${ExportedFilenames[0]}`;
	if ( !IpaFilename )
		throw `Didn't find IPA filename from ${ExportedFilenames}`;
	
	return IpaFilename;
}



async function run() 
{
	//	grab required params
	const AppFilename = GetParam('AppFilename');
	const TestFlightPlatform = GetParam('TestFlightPlatform');
	
	let ArchiveFilename = AppFilename;
	const v001MacosMode = (TestFlightPlatform == PlatformMacos);
	
	if ( TestFlightPlatform == PlatformMacos )
	{
		const SignApp = GetParam('SignApp',true);
		//	gr: needs to be nuanced than this i think
		//		but it will always need to be packaged for upload
		let Keychain = null;
		if ( SignApp )
		{
			await ModifyMacAppForTestFlightAndStore(AppFilename);
			Keychain = await InstallSigningCertificate();
			await CodeSignMacosApp( AppFilename, Keychain );
		}

		const PackageFilename = await PackageApp( AppFilename, Keychain );
		ArchiveFilename = PackageFilename;
	}
	
	if ( TestFlightPlatform == PlatformTvos || TestFlightPlatform == PlatformIos )
	{
		//	archives need to be converted to .ipa's, signed and have provision files embedded
		if ( ArchiveFilename.endsWith('.xcarchive') )
		{
			ArchiveFilename = await ArchiveToIpa(ArchiveFilename);
		}
	}
	
	await InstallAppStoreConnectAuth();
	await VerifyArchive(ArchiveFilename,v001MacosMode);

	//	by default we upload, but user can avoid it
	const DoUpload = GetParam('Upload',true);
	if ( DoUpload )
	{
		const VerifyOnly = false;
		await UploadArchive(ArchiveFilename, VerifyOnly, v001MacosMode);
	}
	else
	{
		console.log(`Skipping package upload`);
	}
}

//  if this throws, set a github action error
run().catch( e => core.setFailed(`${e}`) );
