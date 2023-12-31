import * as core from "@actions/core"

function TypeifyValue(ValueString)
{
	//	already not-a-string so don't change it
	if ( typeof ValueString != typeof '' )
		return ValueString;
	
	switch ( ValueString.toLowerCase().trim() )
	{
		case 'false':
			return false;
			
		case 'true':
			return true;
	}
	
	//	todo? spot ints

	//	no change
	return ValueString;
}



function GetParams()
{
	const Params = {};
	
	function ParseCommandLineArg(Argument)
	{
		const Parts = Argument.split('=');
		let Key = Parts.shift();
		
		//	trim - or --
		while ( Key.startsWith('-') )
			Key = Key.slice(1);
		
		//	ignore empty param
		if ( Key.length == 0 )
		{
			console.warn(`Got empty line param [${Key}]`);
			return;
		}
		
		//	make all params lowercase
		Key = Key.toLowerCase();
		
		//	keep anything with = in the value
		let Value = Parts.join('=');
		//	default non-value'd arguments to true to indicate presence
		if ( Value.length == 0 )
			Value = true;
		
		//	turn false and true keywords into bools, so that "false" == false
		Value = TypeifyValue(Value);
			
		//console.log(`Got command line param [${Key}]=[${Value}]`);
		Params[Key] = Value;
	}
	
	process.argv.forEach(ParseCommandLineArg);
	return Params;
}

const Params = GetParams();


//	if you specify a default, this wont throw and instead return the default
export function GetParam(Key,DefaultValueIfMissing=undefined)
{
	//	gr: lower case only applies to CLI
	let CliKey = Key.toLowerCase();
	
	//	CLI args get priority
	if ( Params.hasOwnProperty(CliKey) )
		return Params[CliKey];

	//	try github inputs
	const InputValue = core.getInput(Key);
	if ( InputValue )
		return InputValue;
	
	//	now try env var
	if ( process.env.hasOwnProperty(Key) )
		return process.env[Key];
	
	if ( DefaultValueIfMissing === undefined )
		throw `Missing required parameter, github input or env var "${Key}"`;
	
	return DefaultValueIfMissing;
}

export default Params;
