
import * as math from 'mathjs';
import { NumeralsLayout, NumeralsRenderStyle, NumeralsSettings } from './settings';
import { mathjsFormat } from './main';
import { getAPI } from 'obsidian-dataview';
import { TFile, finishRenderMath, renderMath, sanitizeHTMLToDom, MarkdownPostProcessorContext, MarkdownView } from 'obsidian';


// TODO: Addition of variables not adding up

export class NumeralsScope extends Map<string, unknown>{}

/**
 * Process frontmatter and return updated scope object
 * - Numbers are converted to mathjs numbers. Strings are processed as mathjs expressions.
 * - Objects are ignored
 * - Frontmatter key `numerals` sets which frontmatter keys are processed (none is default)):
 *  - `numerals: all` processes all frontmatter keys
 *  - `numerals: none` processes no frontmatter keys
 *  - `numerals: key1` processes only the frontmatter key `key1`
 *  - `numerals: [key1, key2, ...]` processes only the listed frontmatter keys
 *  * 
 * @param scope Numerals scope object (Map)
 * @param frontmatter Frontmatter object
 * @returns Updated scope object
 */
export function processFrontmatter(
	frontmatter: { [key: string]: unknown },
	scope: NumeralsScope|undefined,
	forceAll=false,
	stringReplaceMap: StringReplaceMap[] = [],
	keysOnly=false
): NumeralsScope {
	
	if (!scope) {
		scope = new NumeralsScope();
	}

	if (frontmatter && typeof frontmatter === "object") {
		let frontmatter_process:{ [key: string]: unknown } = {}

		// Determine which metadata keys to process
		if (frontmatter.hasOwnProperty("numerals")) {
			if (frontmatter["numerals"] === "none") {
				frontmatter_process = {};
			} else if (frontmatter.hasOwnProperty("numerals") && frontmatter["numerals"] === "all") {
				// Build frontmatter_process from all keys in frontmatter
				for (const [key, value] of Object.entries(frontmatter)) {
					if (key !== "numerals") {
						frontmatter_process[key] = value;
					}
				}
			} else if (typeof frontmatter["numerals"] === "string") {
				if (frontmatter.hasOwnProperty(frontmatter["numerals"])) {
					frontmatter_process[frontmatter["numerals"]] = frontmatter[frontmatter["numerals"]];
				}
			} else if (Array.isArray(frontmatter["numerals"])) {
				for (const key of frontmatter["numerals"]) {
					if (frontmatter.hasOwnProperty(key)) {
						frontmatter_process[key] = frontmatter[key];
					}
				}
			}
		} else if (forceAll) {
			frontmatter_process = frontmatter;
		}

		// Iterate through frontmatter and add any key/value pair to frontmatter_process if the key starts with `$`
		//   These keys are assumed to be numerals globals that are to be added to the scope regardless of the `numerals` key
		for (const [key, value] of Object.entries(frontmatter)) {
			if (key.startsWith('$')) {
				frontmatter_process[key] = value;
			}
		}

		// if keysOnly is true, only add keys to scope. Otherwise, add values to scope
		if (keysOnly === false) {
			for (const [key, rawValue] of Object.entries(frontmatter_process)) {
				let value = rawValue;
				
				// If value is a mathjs unit, convert to string representation
				value = math.isUnit(value) ? value.valueOf() : value;

				// if processedValue is array-like, take the last element. For inline dataview fields, this generally means the most recent line will be used
				if (Array.isArray(value)) {
					value = value[value.length - 1];
				}

				if (typeof value === "number") {
					scope.set(key, math.number(value));
				} else if (typeof value === "string") {
					const processedValue = processTextForReplacements(value, stringReplaceMap);
					// const evaluatedValue = math.evaluate(processedValue);
					// try to evaluate processedValue as a mathjs expression, otherwise drop console error and move on
					let evaluatedValue;
					try {
						evaluatedValue = math.evaluate(processedValue);
					} catch (error) {
						console.error(`Error evaluating frontmatter value for key ${key}: ${error}`);
						evaluatedValue = undefined;
					}
					if (evaluatedValue !== undefined) {
						scope.set(key, evaluatedValue);
					}
				} else if (typeof value === "object") { // TODO this is only a problem with Dataview. Can we only use dataview for inline?
					// ignore objects

					// TODO. RIght now this means data objects just get dropped. If we could instead use the data from obsidian we could handle it
					console.error(`Frontmatter value for key ${key} is an object and will be ignored. ` +
						`Considering surrounding the value with quotes (eg \`${key}: "value"\`) to treat it as a string.`);
				}
			}
		} else {
			for (const key of Object.keys(frontmatter_process)) {
				scope.set(key, undefined);
			}
		}

		return scope;
	} else {
		return scope;
	}
}	

/** 
 * Add globals from a scope to the Numerals page cache
 * 
 * Globals are keys in the scope Map that start with `$`
 * @param sourcePath Path of the source file
 * @param scope Scope object
 * @returns void
 */
export function maybeAddScopeToPageCache(sourcePath: string, scope: NumeralsScope, scopeCache: Map<string, NumeralsScope>) {
	for (const [key, value] of scope.entries()) {
		if (key.startsWith('$')) {
			if (scopeCache.has(sourcePath)) {
				scopeCache.get(sourcePath)?.set(key, value);
			} else {
				const newScope = new NumeralsScope();
				newScope.set(key, value);
				scopeCache.set(sourcePath, newScope);
			}
		}
	}
}

/**
 * Regular expression for matching variables with subscript notation 
 * using `\_`.
 */
const subscriptRegex = /(?<varStart>[\p{L}\p{Nl}_$])(?<varBody>[\p{L}\p{Nl}_$\u00C0-\u02AF\u0370-\u03FF\u2100-\u214F\u{1D400}-\u{1D7FF}\d]*)(\\_)(?<varEnd>[\p{L}\p{Nl}_$\u00C0-\u02AF\u0370-\u03FF\u2100-\u214F\u{1D400}-\u{1D7FF}\d]+)/gu;

/**
 * Transforms a given string by unescaping and reformatting subscript notation.
 *
 * This function takes a string that contains variables with subscript notation, 
 * where the subscript is written as `\_` followed by the subscript characters 
 * (e.g. `var\_subscript`), and reformat it to use underscore and curly braces 
 * (e.g. `var_{subscript}`).
 *
 * The function is useful for processing strings that represent mathematical 
 * notation or code, and need to be reformatted into a more standardized or 
 * readable subscript notation.
 *
 * @param input - A string potentially containing variables with subscript 
 * notation using `\_`.
 *
 * @returns The input string with the subscript notation reformatted, where each
 * `var\_subscript` is replaced with `var_{subscript}`.
 *
 * @example
 * ```typescript
 * const input = "a\_1 + b\_2 = c\_3";
 * const output = unescapeSubscripts(input);
 * console.log(output); // "a_{1} + b_{2} = c_{3}"
 * ```
 */
export function unescapeSubscripts(input: string): string {
    const output = input.replace(subscriptRegex, (match, varStart, varBody, _, varEnd) => {
        return `${varStart}${varBody}_{${varEnd}}`;
    });
  
    return output;
}

export interface StringReplaceMap {
	regex: RegExp;
	replaceStr: string;
}

/**
 * Process a block of text to convert from Numerals syntax to MathJax syntax
 * @param text Text to process
 * @param stringReplaceMap Array of StringReplaceMap objects to use for replacement
 * @returns Processed text
 */
export function processTextForReplacements(text: string, stringReplaceMap: StringReplaceMap[]): string {
	for (const processor of stringReplaceMap ) {
		text = text.replace(processor.regex, processor.replaceStr)
	}
	return text;
}

const numeralsLayoutClasses = {
	[NumeralsLayout.TwoPanes]: 		"numerals-panes",
	[NumeralsLayout.AnswerRight]: 	"numerals-answer-right",
	[NumeralsLayout.AnswerBelow]: 	"numerals-answer-below",
	[NumeralsLayout.AnswerInline]: 	"numerals-answer-inline",	
}

const numeralsRenderStyleClasses = {
	[NumeralsRenderStyle.Plain]: 			"numerals-plain",
	[NumeralsRenderStyle.TeX]: 			 	"numerals-tex",
	[NumeralsRenderStyle.SyntaxHighlight]: 	"numerals-syntax",
}


// TODO: see if would be faster to return a single set of RegEx to get executed, rather than re-computing regex each time
/**
 * Replaces currency symbols in a given TeX string with their corresponding TeX command.
 *
 * This function takes a TeX string as input, and replaces all occurrences of currency symbols
 * (e.g., "$", "€", "£", "¥", "₹") with their corresponding TeX command (e.g., "\dollar", "\euro",
 * "\pound", "\yen", "\rupee"). The mapping between symbols and commands is defined by the
 * `defaultCurrencyMap` array.
 *
 * @param input_tex - The input TeX string, potentially containing currency symbols.
 *
 * @returns The input string with all currency symbols replaced with their corresponding TeX command.
 */
function texCurrencyReplacement(input_tex:string) {
	for (const symbolType of defaultCurrencyMap) {
		input_tex = input_tex.replace(RegExp("\\\\*\\"+symbolType.symbol,'g'),"\\" + symbolType.name  + " ");
	}
	return input_tex
}

// TODO: Add a switch for only rendering input
export interface CurrencyType {
	symbol: string;
	unicode: string;
	name: string;
	currency: string;
}

export const defaultCurrencyMap: CurrencyType[] = [
	{	symbol: "$", unicode: "x024", 	name: "dollar", currency: "USD"},
	{	symbol: "€", unicode: "x20AC",	name: "euro", 	currency: "EUR"},
	{	symbol: "£", unicode: "x00A3",	name: "pound", 	currency: "GBP"},
	{	symbol: "¥", unicode: "x00A5",	name: "yen", 	currency: "JPY"},
	{	symbol: "₹", unicode: "x20B9",	name: "rupee", 	currency: "INR"}	
];

/**
 * Converts a string of HTML into a DocumentFragment continaing a sanitized collection array of DOM elements.
 *
 * @param html The HTML string to convert.
 * @returns A DocumentFragment contaning DOM elements.
 */
export function htmlToElements(html: string): DocumentFragment {
	const sanitizedHTML = sanitizeHTMLToDom(html);
	return sanitizedHTML;
  }

async function mathjaxLoop(container: HTMLElement, value: string) {
	const html = renderMath(value, true);
	await finishRenderMath()

	// container.empty();
	container.append(html);
}

/**
 * Return a function that formats a number according to the given locale
 * @param locale Locale to use
 * @param options Options to use (see https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/NumberFormat/NumberFormat)
 * @returns Function that calls toLocaleString with given locale
 */
export function getLocaleFormatter(
	locale: Intl.LocalesArgument | undefined = undefined,
	options: Intl.NumberFormatOptions | undefined = undefined
): (value: number) => string {
	if (locale === undefined) {
		return (value: number): string => value.toLocaleString();
	} else if (options === undefined) {
		return (value: number): string => value.toLocaleString(locale);
	} else {
		return (value: number): string => value.toLocaleString(locale, options);
	}
}

/**
 * Retrieves metadata for a file at the specified path.
 * 
 * This function takes a source path as input and retrieves the metadata associated with the file at that path. 
 * It first checks the metadata cache for the file and retrieves the frontmatter. 
 * If the file is a Dataview file, it also retrieves the Dataview metadata. 
 * The function then combines the frontmatter and Dataview metadata, with the Dataview metadata taking precedence.
 * 
 * @param sourcePath - The path of the file for which to retrieve metadata.
 * @returns The metadata for the file, including both frontmatter and Dataview metadata.
 */
export function getMetadataForFileAtPath(sourcePath:string): {[key: string]: unknown} | undefined {
	const f_path:string = sourcePath;
	const handle = app.vault.getAbstractFileByPath(f_path);
	const f_handle = (handle instanceof TFile) ? handle : undefined;
	const f_cache = f_handle ? app.metadataCache.getFileCache(f_handle as TFile) : undefined;
	const frontmatter:{[key: string]: unknown} | undefined = {...(f_cache?.frontmatter), position: undefined};

	const dataviewAPI = getAPI();
	let dataviewMetadata:{[key: string]: unknown} | undefined;
	if (dataviewAPI) {
		const dataviewPage = dataviewAPI.page(f_path)
		dataviewMetadata = {...dataviewPage, file: undefined, position: undefined}
	}
 
	//@ts-expect-error
	const numeralsCache:Map<string, NumeralsScope> = app.plugins.plugins.numerals.scopeCache;
	const numeralsPageScope = numeralsCache.get(f_path) as Map<string,unknown>;
	const numeralsPageScopeMetadata:{[key: string]: unknown} = numeralsPageScope ? Object.fromEntries(numeralsPageScope) : {};
  
	// combine frontmatter and dataview metadata, with dataview metadata taking precedence and numerals scope taking precedence over both
	const metadata = {...frontmatter, ...dataviewMetadata, ...numeralsPageScopeMetadata};		
	return metadata;
}	

/**  
 * Renders a Numerals block from a given source string, using provided metadata and settings.  
 *   
 * This function takes a source string, which represents a block of Numerals code, and processes it   
 * to generate a rendered Numerals block. The block is appended to a given HTML element. The function   
 * also uses provided metadata and settings to control the rendering process.  
 *  
 * @param el - The HTML element to which the rendered Numerals block is appended.  
 * @param source - The source string representing the Numerals block to be rendered.  
 * @param metadata - An object containing metadata that is used during the rendering process. This   
 * metadata can include information about the Numerals block, such as frontmatter keys and values.  
 * @param type - A NumeralsRenderStyle value that specifies the rendering style to be used for the   
 * Numerals block.  
 * @param settings - A NumeralsSettings object that provides settings for the rendering process. These   
 * settings can control aspects such as the layout style, whether to alternate row colors, and whether   
 * to hide lines without markup when emitting.  
 * @param numberFormat - A mathjsFormat function that is used to format numbers in the Numerals block.  
 * @param preProcessors - An array of StringReplaceMap objects that specify text replacements to be   
 * made in the source string before it is processed.  
 *  
 * @returns void  
 *
 */  
export function processAndRenderNumeralsBlockFromSource(
	el: HTMLElement,
	source: string,
	ctx: MarkdownPostProcessorContext,
	metadata: {[key: string]: unknown} | undefined,
	type: NumeralsRenderStyle,
	settings: NumeralsSettings,
	numberFormat: mathjsFormat,
	preProcessors: StringReplaceMap[]
): NumeralsScope {
	const blockRenderStyle: NumeralsRenderStyle = type ? type : settings.defaultRenderStyle;
		
	el.toggleClass("numerals-block", true);
	el.toggleClass(numeralsLayoutClasses[settings.layoutStyle], true);
	el.toggleClass(numeralsRenderStyleClasses[blockRenderStyle], true);			
	el.toggleClass("numerals-alt-row-color", settings.alternateRowColor)


	// Pre-process input

	const rawRows: string[] = source.split("\n");
	let processedSource:string = source;

	// find every line that ends with `=>` (ignore any whitespace or comments after it)
	const emitter_lines: number[] = [];
	const insertion_lines: number[] = [];
	const insertion_variables: string[] = [];
	for (let i = 0; i < rawRows.length; i++) {
		if (rawRows[i].match(/^[^#\r\n]*=>.*$/)) {				 								
			emitter_lines.push(i);
		}

		const insertionMatch = rawRows[i].match(/@\s*\[([^\]:]+)(::)?([^\]]*)\].*$/);
		if (insertionMatch) {
			insertion_lines.push(i)
			insertion_variables.push(insertionMatch[1]);
		}
	} 

	// if there are any emitter lines then add the class `numerals-emitters-present` to the block
	if (emitter_lines.length > 0) {
		el.toggleClass("numerals-emitters-present", true);
		el.toggleClass("numerals-hide-non-emitters", settings.hideLinesWithoutMarkupWhenEmitting);
	}
 
	// remove `=>` at the end of lines (preserve comments)
	processedSource = processedSource.replace(/^([^#\r\n]*)(=>[\t ]*)(\$\{.*\})?(.*)$/gm,"$1") 

	// Check for result insertion directive `@[variable::result]`,and replace with only variable
	processedSource = processedSource.replace(/@\s*\[([^\]:]+)(::([^\]].*))?\].*$/gm, "$1")
		
	for (const processor of preProcessors ) {
		processedSource = processedSource.replace(processor.regex, processor.replaceStr)
	}
	
	// Process input through mathjs

	let errorMsg = null;
	let errorInput = '';

	const rows: string[] = processedSource.split("\n");
	const results: string[] = [];
	const inputs: string[] = [];			
	// eslint-disable-next-line prefer-const
	let scope:NumeralsScope = new NumeralsScope();

	// Add numeric frontmatter to scope

	if (metadata) {
		scope = processFrontmatter(
			metadata,
			scope,
			settings.forceProcessAllFrontmatter,
			preProcessors);
	}

			
	for (const row of rows.slice(0,-1)) { // Last row may be empty
		try {
			results.push(math.evaluate(row, scope));
			inputs.push(row); // Only pushes if evaluate is successful
		} catch (error) {
			errorMsg = error;
			errorInput = row;
			break;
		}
	}

	const lastRow = rows.slice(-1)[0];
	if (lastRow != '') { // Last row is always empty in reader view
		try {
			results.push(math.evaluate(lastRow, scope));
			inputs.push(lastRow); // Only pushes if evaluate is successful
		} catch (error) {
			errorMsg = error;
			errorInput = lastRow;
		}
	}	
					
	for (let i = 0; i < inputs.length; i++) {
		const line = el.createEl("div", {cls: "numerals-line"});
		const emptyLine = (results[i] === undefined)

		// if line is an emitter lines, add numerals-emitter class	
		if (emitter_lines.includes(i)) {
			line.toggleClass("numerals-emitter", true);
		}

		if (insertion_lines.includes(i)) {
			const sectionInfo = ctx.getSectionInfo(el);
			const lineStart = sectionInfo?.lineStart;

			if (lineStart !== undefined) {
				const editor = app.workspace.getActiveViewOfType(MarkdownView)?.editor;
				const curLine = lineStart + i + 1;
				const sourceLine = editor?.getLine(curLine);
				const insertionValue = math.format(results[i], numberFormat);
				const modifiedSource = sourceLine?.replace(/(@\s*\[)([^\]:]+)(::([^\]]*))?(\].*)$/gm, `$1$2::${insertionValue}$5`)
				if (modifiedSource && modifiedSource !== sourceLine) {
					setTimeout(() => {
						editor?.setLine(curLine, modifiedSource)
					}, 0);
				}
			}
		}
 
		// if hideEmitters setting is true, remove => from the raw text (already removed from processed text)
		if (settings.hideEmitterMarkupInInput) {
			rawRows[i] = rawRows[i].replace(/^([^#\r\n]*)(=>[\t ]*)(\$\{.*\})?(.*)$/gm,"$1$4") 
		}

		rawRows[i] = rawRows[i].replace(/@\s*\[([^\]:]+)(::([^\]].*))?\].*$/gm, "$1")

		let inputElement: HTMLElement, resultElement: HTMLElement;
		switch(blockRenderStyle) {
			case NumeralsRenderStyle.Plain: {
				const rawInputSansComment = rawRows[i].replace(/#.+$/, "")
				const inputText = emptyLine ? rawRows[i] : rawInputSansComment;
				inputElement = line.createEl("span", { text: inputText, cls: "numerals-input"});
				
				const formattedResult = !emptyLine ? settings.resultSeparator + math.format(results[i], numberFormat) : '\xa0';
				resultElement = line.createEl("span", { text: formattedResult, cls: "numerals-result" });

				break;
			} case NumeralsRenderStyle.TeX: {
				const inputText = emptyLine ? rawRows[i] : ""; // show comments from raw text if no other input
				inputElement = line.createEl("span", {text: inputText, cls: "numerals-input"});
				const resultContent = !emptyLine ? "" : '\xa0';
				resultElement = line.createEl("span", { text: resultContent, cls: "numerals-result" });
				if (!emptyLine) {
					// Input to Tex
					const preprocess_input_tex:string = math.parse(inputs[i]).toTex();
					let input_tex:string = unescapeSubscripts(preprocess_input_tex);
					
					const inputTexElement = inputElement.createEl("span", {cls: "numerals-tex"})

					input_tex = texCurrencyReplacement(input_tex);
					mathjaxLoop(inputTexElement, input_tex);

					// Result to Tex
					const resultTexElement = resultElement.createEl("span", {cls: "numerals-tex"})

					// format result to string to get reasonable precision. Commas will be stripped
					let processedResult:string = math.format(results[i], getLocaleFormatter('en-US', {useGrouping: false}));
					for (const processor of preProcessors ) {
						processedResult = processedResult.replace(processor.regex, processor.replaceStr)
					}
					let texResult = math.parse(processedResult).toTex() // TODO: Add custom handler for numbers to get good localeString formatting
					texResult = texCurrencyReplacement(texResult);
					mathjaxLoop(resultTexElement, texResult);
				}
				break;
			} case NumeralsRenderStyle.SyntaxHighlight: {
				const inputText = emptyLine ? rawRows[i] : ""; // show comments from raw text if no other input
				inputElement = line.createEl("span", {text: inputText, cls: "numerals-input"});
				if (!emptyLine) {
					const input_elements:DocumentFragment = htmlToElements(math.parse(inputs[i]).toHTML())
					inputElement.appendChild(input_elements);
				}

				const formattedResult = !emptyLine ? settings.resultSeparator + math.format(results[i], numberFormat) : '\xa0';
				resultElement = line.createEl("span", { text: formattedResult, cls: "numerals-result" });

				break;
			}
		}

		if (!emptyLine) {
			const inlineComment = rawRows[i].match(/#.+$/);
			if (inlineComment){
				inputElement.createEl("span", {cls: "numerals-inline-comment", text:inlineComment[0]})
			}
		} else {
			resultElement.toggleClass("numerals-empty", true);
			inputElement.toggleClass("numerals-empty", true);
			resultElement.setText('\xa0');
		}
	}


	if (errorMsg) {			
		const line = el.createEl("div", {cls: "numerals-error-line"});
		line.createEl("span", { text: errorInput, cls: "numerals-input"});
		const resultElement = line.createEl("span", {cls: "numerals-result" });
		resultElement.createEl("span", {cls:"numerals-error-name", text: errorMsg.name + ":"});
		resultElement.createEl("span", {cls:"numerals-error-message", text: errorMsg.message});		
	}

	return scope;

}
