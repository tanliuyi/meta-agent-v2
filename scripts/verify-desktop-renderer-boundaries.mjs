import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const DEFAULT_RENDERER_ROOT = "packages/desktop/src/renderer/src";
const COMPONENT_WRAPPERS = new Set(["forwardRef", "lazy", "memo"]);
const RENDERER_LAYERS = new Set(["app", "components", "features", "runtime", "shared", "state"]);
const FORBIDDEN_PACKAGE_BARRELS = new Map([
	["radix-ui", "import the exact @radix-ui/react-* package"],
]);
const LUCIDE_PER_ICON_MODULE = /^lucide-react\/dist\/esm\/icons\/(?!index\.mjs$)[a-z0-9-]+\.mjs$/;
const CSS_LAYER_ORDER = "@layer theme, base, components, utilities, overrides;";
const LOCAL_STYLE_IMPORTS = new Map([
	["tokens.css", '@import "./tokens.css";'],
	["base.css", '@import "./base.css";'],
	["components.css", '@import "./components.css" layer(components);'],
	["layout.css", '@import "./layout.css" layer(components);'],
	["models-settings.css", '@import "./models-settings.css" layer(components);'],
	["chat.css", '@import "./chat.css" layer(components);'],
	["markdown.css", '@import "./markdown.css" layer(components);'],
	["panel.css", '@import "./panel.css" layer(components);'],
	["utilities.css", '@import "./utilities.css";'],
	["overrides.css", '@import "./overrides.css" layer(overrides);'],
]);
const RAW_COLOR_LITERAL = /#[\da-f]{3,8}\b|(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(\s*(?!var\()/gi;
const RAW_NAMED_COLOR =
	/(?:^|[;{]\s*)(?:color|background(?:-color)?|border(?:-[\w-]+)?-color|outline-color|fill|stroke)\s*:\s*(white|black|red|blue|green|yellow|orange|purple|gray|grey|pink|brown|cyan|magenta)\b/gim;
const TAILWIND_FIXED_PALETTE =
	/\b(?:bg|text|border|ring|outline|fill|stroke|shadow)-(?:white|black|slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)(?:-\d{2,3})?(?:\b|\/)/gi;
const TAILWIND_IMPORTANT_UTILITY =
	/\b(?:bg|text|border|ring|outline|fill|stroke|shadow|opacity|rounded|[pm][trblxy]?|[wh]|min-[wh]|max-[wh]|z|duration)-[^\s"'`]+!(?=[\s"'`])/gi;
const CSS_STATE_MODIFIER =
	/\.([a-z_][\w-]*)\.(active|running|error|danger|selected|open|closed|disabled|pending)\b/gi;
const ALLOWED_CSS_STATE_MODIFIERS = new Set(["menu-item.danger"]);
const ALLOWED_IS_STATE_CLASSES = new Set(["is-resizing-column", "is-resizing-row"]);
const PRIMITIVE_PARTS = new Set([
	"Close",
	"Content",
	"Description",
	"Fallback",
	"Group",
	"Image",
	"Item",
	"List",
	"Overlay",
	"Portal",
	"Provider",
	"Root",
	"Title",
	"Trigger",
	"Value",
]);
const ALLOWED_LAYER_IMPORTS = new Map([
	["main", new Set(["app"])],
	["app", new Set(["app", "components", "features", "shared", "state"])],
	["features", new Set(["components", "features", "shared", "state"])],
	["components", new Set(["components", "runtime", "shared", "state"])],
	["state", new Set(["runtime", "shared", "state"])],
	["runtime", new Set(["runtime", "shared"])],
	["shared", new Set(["shared"])],
]);

function parseArguments(arguments_) {
	let rendererRoot = resolve(DEFAULT_RENDERER_ROOT);
	const scopes = [];
	for (let index = 0; index < arguments_.length; index += 1) {
		const argument = arguments_[index];
		if (argument === "--root") {
			const value = arguments_[index + 1];
			if (!value) throw new Error("--root requires a path");
			rendererRoot = resolve(value);
			index += 1;
		} else {
			scopes.push(resolve(argument));
		}
	}
	return { rendererRoot, scopes: scopes.length > 0 ? scopes : [rendererRoot] };
}

function collectSourceFiles(path, files) {
	const metadata = statSync(path);
	if (metadata.isFile()) {
		if (/\.[cm]?[jt]sx?$/.test(path) && !path.endsWith(".d.ts")) files.push(path);
		return;
	}
	for (const entry of readdirSync(path, { withFileTypes: true })) {
		if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
		collectSourceFiles(join(path, entry.name), files);
	}
}

function isPascalCase(name) {
	return /^[A-Z][A-Za-z0-9]*$/.test(name);
}

function containsJsx(node) {
	let found = false;
	function visit(current) {
		if (found) return;
		if (ts.isJsxElement(current) || ts.isJsxFragment(current) || ts.isJsxSelfClosingElement(current)) {
			found = true;
			return;
		}
		ts.forEachChild(current, visit);
	}
	visit(node);
	return found;
}

function unwrapExpression(expression) {
	let current = expression;
	while (
		ts.isAsExpression(current) ||
		ts.isParenthesizedExpression(current) ||
		ts.isSatisfiesExpression(current) ||
		ts.isTypeAssertionExpression(current)
	) {
		current = current.expression;
	}
	return current;
}

function reactWrapperBindings(sourceFile) {
	const identifiers = new Set();
	const namespaces = new Set();
	for (const statement of sourceFile.statements) {
		if (
			!ts.isImportDeclaration(statement) ||
			!ts.isStringLiteralLike(statement.moduleSpecifier) ||
			statement.moduleSpecifier.text !== "react"
		) {
			continue;
		}
		const importClause = statement.importClause;
		if (!importClause || importClause.isTypeOnly) continue;
		if (importClause.name) namespaces.add(importClause.name.text);
		const bindings = importClause.namedBindings;
		if (bindings && ts.isNamespaceImport(bindings)) {
			namespaces.add(bindings.name.text);
		} else if (bindings && ts.isNamedImports(bindings)) {
			for (const element of bindings.elements) {
				if (element.isTypeOnly) continue;
				const importedName = element.propertyName?.text ?? element.name.text;
				if (COMPONENT_WRAPPERS.has(importedName)) identifiers.add(element.name.text);
			}
		}
	}
	return { identifiers, namespaces };
}

function isReactWrapperCall(expression, bindings) {
	if (ts.isIdentifier(expression)) return bindings.identifiers.has(expression.text);
	return (
		ts.isPropertyAccessExpression(expression) &&
		ts.isIdentifier(expression.expression) &&
		bindings.namespaces.has(expression.expression.text) &&
		COMPONENT_WRAPPERS.has(expression.name.text)
	);
}

function isComponentInitializer(initializer, bindings) {
	const expression = unwrapExpression(initializer);
	if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) return true;
	if (ts.isCallExpression(expression)) return isReactWrapperCall(expression.expression, bindings);
	return ts.isPropertyAccessExpression(expression) && PRIMITIVE_PARTS.has(expression.name.text);
}

function hasDefaultModifier(node) {
	return node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword) === true;
}

function componentDeclaration(node, bindings) {
	if (ts.isFunctionDeclaration(node)) {
		if (node.name && isPascalCase(node.name.text)) return { name: node.name.text, node: node.name };
		if (!node.name && hasDefaultModifier(node)) return { name: "default export", node };
	}
	if (ts.isClassDeclaration(node) && containsJsx(node)) {
		if (node.name && isPascalCase(node.name.text)) return { name: node.name.text, node: node.name };
		if (!node.name && hasDefaultModifier(node)) return { name: "default export", node };
	}
	if (
		ts.isVariableDeclaration(node) &&
		ts.isIdentifier(node.name) &&
		isPascalCase(node.name.text) &&
		node.initializer &&
		isComponentInitializer(node.initializer, bindings)
	) {
		return { name: node.name.text, node: node.name };
	}
	if (ts.isExportAssignment(node) && !node.isExportEquals && isComponentInitializer(node.expression, bindings)) {
		return { name: "default export", node };
	}
	return undefined;
}

function isTopLevelDeclaration(node) {
	if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) return ts.isSourceFile(node.parent);
	if (ts.isExportAssignment(node)) return ts.isSourceFile(node.parent);
	if (!ts.isVariableDeclaration(node)) return false;
	const statement = node.parent?.parent;
	return statement !== undefined && ts.isVariableStatement(statement) && ts.isSourceFile(statement.parent);
}

function location(file, sourceFile, node) {
	const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
	return `${relative(process.cwd(), file)}:${line + 1}:${character + 1}`;
}

function textLocation(file, content, index) {
	const prefix = content.slice(0, index);
	const line = prefix.split("\n").length;
	const previousNewline = prefix.lastIndexOf("\n");
	return `${relative(process.cwd(), file)}:${line}:${index - previousNewline}`;
}

function checkComponents(file, sourceFile, diagnostics) {
	if (!file.endsWith(".tsx")) return;
	const topLevel = [];
	const bindings = reactWrapperBindings(sourceFile);
	function visit(node) {
		const declaration = componentDeclaration(node, bindings);
		if (declaration) {
			if (isTopLevelDeclaration(node)) topLevel.push(declaration);
			else if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isVariableDeclaration(node)) {
				diagnostics.push(
					`${location(file, sourceFile, declaration.node)}: nested React component ${declaration.name} is not allowed`,
				);
			}
		}
		ts.forEachChild(node, visit);
	}
	visit(sourceFile);
	if (topLevel.length > 1) {
		diagnostics.push(
			`${location(file, sourceFile, topLevel[1].node)}: one component per file; found ${topLevel.map(({ name }) => name).join(", ")}`,
		);
	}
}

function checkComponentColorTokens(file, sourceFile, diagnostics) {
	if (!file.endsWith(".tsx")) return;
	for (const match of sourceFile.text.matchAll(RAW_COLOR_LITERAL)) {
		diagnostics.push(
			`${textLocation(file, sourceFile.text, match.index)}: component color literal ${match[0]} is not allowed; use a renderer color token`,
		);
	}
	for (const match of sourceFile.text.matchAll(TAILWIND_FIXED_PALETTE)) {
		diagnostics.push(
			`${textLocation(file, sourceFile.text, match.index)}: Tailwind fixed palette ${match[0]} is not allowed; use a semantic renderer color token`,
		);
	}
	for (const match of sourceFile.text.matchAll(TAILWIND_IMPORTANT_UTILITY)) {
		diagnostics.push(
			`${textLocation(file, sourceFile.text, match.index)}: Tailwind important utility ${match[0]} is not allowed; use a documented CSS override when required`,
		);
	}
}

function stripCssComments(content) {
	return content.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));
}

function blockRanges(content, marker) {
	const ranges = [];
	let searchIndex = 0;
	while (searchIndex < content.length) {
		const markerIndex = content.indexOf(marker, searchIndex);
		if (markerIndex < 0) break;
		const openIndex = content.indexOf("{", markerIndex + marker.length);
		if (openIndex < 0) break;
		let depth = 1;
		let closeIndex = openIndex + 1;
		while (closeIndex < content.length && depth > 0) {
			if (content[closeIndex] === "{") depth += 1;
			if (content[closeIndex] === "}") depth -= 1;
			closeIndex += 1;
		}
		if (depth === 0) ranges.push([openIndex, closeIndex]);
		searchIndex = closeIndex;
	}
	return ranges;
}

function checkImportantDeclarations(file, content, diagnostics) {
	const importantMatches = [...content.matchAll(/!important\b/g)];
	if (importantMatches.length === 0) return;
	const name = basename(file);
	if (name === "base.css") {
		const accessibilityRanges = [
			...blockRanges(content, "@media (prefers-reduced-motion: reduce)"),
			...blockRanges(content, "@media (forced-colors: active)"),
		];
		for (const match of importantMatches) {
			if (accessibilityRanges.some(([start, end]) => match.index >= start && match.index < end)) continue;
			diagnostics.push(
				`${textLocation(file, content, match.index)}: !important is only allowed inside accessibility media queries in base.css`,
			);
		}
		return;
	}
	if (name === "overrides.css") {
		const annotatedRanges = [];
		const annotatedRule = /\/\*[\s\S]*?移除条件[:：][\s\S]*?\*\/\s*[^{}]+\{[^{}]*!important[^{}]*\}/g;
		for (const match of content.matchAll(annotatedRule)) {
			annotatedRanges.push([match.index, match.index + match[0].length]);
		}
		for (const match of importantMatches) {
			if (annotatedRanges.some(([start, end]) => match.index >= start && match.index < end)) continue;
			diagnostics.push(
				`${textLocation(file, content, match.index)}: overrides using !important require an adjacent 移除条件 comment`,
			);
		}
		return;
	}
	for (const match of importantMatches) {
		diagnostics.push(
			`${textLocation(file, content, match.index)}: !important is only allowed for reduced motion or documented overrides`,
		);
	}
}

function checkCssFile(file, content, diagnostics) {
	const name = basename(file);
	const source = stripCssComments(content);
	if (name !== "tokens.css") {
		for (const [pattern, valueIndex] of [
			[RAW_COLOR_LITERAL, 0],
			[RAW_NAMED_COLOR, 1],
		]) {
			for (const match of source.matchAll(pattern)) {
				diagnostics.push(
					`${textLocation(file, content, match.index)}: CSS color literal ${match[valueIndex].trim()} is not allowed outside tokens.css`,
				);
			}
		}
	}
	for (const match of source.matchAll(CSS_STATE_MODIFIER)) {
		const modifier = `${match[1]}.${match[2]}`;
		if (ALLOWED_CSS_STATE_MODIFIERS.has(modifier)) continue;
		diagnostics.push(
			`${textLocation(file, content, match.index)}: CSS state modifier .${modifier} is not allowed; expose state with data-state, data-active, or data-tone`,
		);
	}
	for (const match of source.matchAll(/\.is-[\w-]+\b/g)) {
		const stateClass = match[0].slice(1);
		if (ALLOWED_IS_STATE_CLASSES.has(stateClass)) continue;
		diagnostics.push(
			`${textLocation(file, content, match.index)}: global state class ${match[0]} is not allowed; expose state with a data attribute`,
		);
	}
	checkImportantDeclarations(file, content, diagnostics);
}

function checkCssSystem(rendererRoot, diagnostics) {
	const rootEntry = join(rendererRoot, "styles.css");
	const stylesDirectory = join(rendererRoot, "styles");
	const indexFile = join(stylesDirectory, "index.css");
	if (!existsSync(rootEntry) && !existsSync(indexFile)) return;
	if (!existsSync(rootEntry) || readFileSync(rootEntry, "utf8").trim() !== '@import "./styles/index.css";') {
		diagnostics.push(`${relative(process.cwd(), rootEntry)}: renderer CSS root must only import ./styles/index.css`);
	}
	if (!existsSync(indexFile)) {
		diagnostics.push(`${relative(process.cwd(), indexFile)}: renderer CSS index is missing`);
		return;
	}

	const indexContent = readFileSync(indexFile, "utf8");
	if (!indexContent.trimStart().startsWith(CSS_LAYER_ORDER)) {
		diagnostics.push(`${relative(process.cwd(), indexFile)}: renderer CSS index must declare ${CSS_LAYER_ORDER}`);
	}
	let previousImportIndex = -1;
	for (const [name, expectedImport] of LOCAL_STYLE_IMPORTS) {
		const importIndex = indexContent.indexOf(expectedImport);
		if (importIndex < 0) {
			diagnostics.push(`${relative(process.cwd(), indexFile)}: missing layered CSS import ${expectedImport}`);
			continue;
		}
		if (importIndex < previousImportIndex) {
			diagnostics.push(`${relative(process.cwd(), indexFile)}: local CSS imports do not follow the documented layer order`);
		}
		previousImportIndex = importIndex;
		const file = join(stylesDirectory, name);
		if (!existsSync(file)) {
			diagnostics.push(`${relative(process.cwd(), file)}: imported renderer CSS file is missing`);
			continue;
		}
		checkCssFile(file, readFileSync(file, "utf8"), diagnostics);
	}
	for (const entry of readdirSync(stylesDirectory, { withFileTypes: true })) {
		if (!entry.isFile() || !entry.name.endsWith(".css") || entry.name === "index.css") continue;
		if (!LOCAL_STYLE_IMPORTS.has(entry.name)) {
			diagnostics.push(
				`${relative(process.cwd(), join(stylesDirectory, entry.name))}: renderer CSS file has no documented layer ownership`,
			);
		}
	}
	for (const [name, layer] of [
		["tokens.css", "theme"],
		["base.css", "base"],
		["utilities.css", "utilities"],
	]) {
		const file = join(stylesDirectory, name);
		if (existsSync(file) && !readFileSync(file, "utf8").includes(`@layer ${layer}`)) {
			diagnostics.push(`${relative(process.cwd(), file)}: ${name} must own the ${layer} layer`);
		}
	}
}

function rendererPathForSpecifier(file, specifier, rendererRoot) {
	if (specifier.startsWith("@renderer/")) return join(rendererRoot, specifier.slice("@renderer/".length));
	return specifier.startsWith(".") ? resolve(dirname(file), specifier) : undefined;
}

function layerForPath(path, rendererRoot) {
	const relativePath = relative(rendererRoot, path);
	if (relativePath.startsWith(`..${sep}`) || relativePath === "..") return undefined;
	const entry = relativePath.split(sep)[0];
	if (entry === "main.ts" || entry === "main.tsx") return "main";
	return RENDERER_LAYERS.has(entry) ? entry : undefined;
}

function checkImportBoundaries(file, sourceFile, rendererRoot, diagnostics) {
	const sourceLayer = layerForPath(file, rendererRoot);
	const allowed = sourceLayer ? ALLOWED_LAYER_IMPORTS.get(sourceLayer) : undefined;
	if (!allowed) return;
	for (const moduleSpecifier of collectModuleSpecifiers(sourceFile)) {
		if (
			(moduleSpecifier.text === "lucide-react" || moduleSpecifier.text.startsWith("lucide-react/")) &&
			!LUCIDE_PER_ICON_MODULE.test(moduleSpecifier.text)
		) {
			diagnostics.push(
				`${location(file, sourceFile, moduleSpecifier)}: package barrel ${moduleSpecifier.text} is not allowed; import the typed per-icon ESM module`,
			);
			continue;
		}
		const barrelAlternative = FORBIDDEN_PACKAGE_BARRELS.get(moduleSpecifier.text);
		if (barrelAlternative) {
			diagnostics.push(
				`${location(file, sourceFile, moduleSpecifier)}: package barrel ${moduleSpecifier.text} is not allowed; ${barrelAlternative}`,
			);
			continue;
		}
		const target = rendererPathForSpecifier(file, moduleSpecifier.text, rendererRoot);
		const targetLayer = target ? layerForPath(target, rendererRoot) : undefined;
		if (!targetLayer || allowed.has(targetLayer)) continue;
		diagnostics.push(
			`${location(file, sourceFile, moduleSpecifier)}: ${sourceLayer} must not import ${targetLayer}`,
		);
	}
}

function collectModuleSpecifiers(sourceFile) {
	const specifiers = [];
	function visit(node) {
		if (
			(ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
			node.moduleSpecifier &&
			ts.isStringLiteralLike(node.moduleSpecifier)
		) {
			specifiers.push(node.moduleSpecifier);
		} else if (
			ts.isCallExpression(node) &&
			node.expression.kind === ts.SyntaxKind.ImportKeyword &&
			node.arguments.length === 1 &&
			ts.isStringLiteralLike(node.arguments[0])
		) {
			specifiers.push(node.arguments[0]);
		}
		ts.forEachChild(node, visit);
	}
	visit(sourceFile);
	return specifiers;
}

function checkReExportBarrels(file, sourceFile, diagnostics) {
	const reExports = sourceFile.statements.filter((statement) => ts.isExportDeclaration(statement));
	if (reExports.length === 0) return;
	const ownsDeclaration = sourceFile.statements.some(
		(statement) =>
			!ts.isImportDeclaration(statement) &&
			!ts.isExportDeclaration(statement) &&
			!ts.isEmptyStatement(statement) &&
			!(
				ts.isExpressionStatement(statement) &&
				ts.isStringLiteralLike(statement.expression)
			),
	);
	const aggregatesExports =
		reExports.length > 1 ||
		reExports.some(
			(statement) =>
				statement.exportClause === undefined ||
				ts.isNamespaceExport(statement.exportClause) ||
				(ts.isNamedExports(statement.exportClause) && statement.exportClause.elements.length > 1),
		);
	if (ownsDeclaration && !aggregatesExports) return;
	diagnostics.push(
		`${location(file, sourceFile, reExports[0])}: renderer re-export barrel files are not allowed; export owned declarations directly`,
	);
}

function checkSourceOwner(file, rendererRoot, diagnostics) {
	if (layerForPath(file, rendererRoot)) return;
	diagnostics.push(
		`${relative(process.cwd(), file)}: renderer source must live in main.tsx or an app/components/features/runtime/shared/state layer`,
	);
}

/** 校验 renderer 的组件文件和单向依赖边界，返回稳定、可测试的诊断文本。 */
export function verifyRendererBoundaries(rendererRoot, scopes) {
	const files = [];
	for (const scope of scopes) collectSourceFiles(scope, files);
	const uniqueFiles = [...new Set(files)].sort();
	const diagnostics = [];
	for (const file of uniqueFiles) {
		if (basename(file) === "index.ts" || basename(file) === "index.tsx") {
			diagnostics.push(`${relative(process.cwd(), file)}: local barrel files are not allowed`);
		}
		const sourceFile = ts.createSourceFile(
			file,
			readFileSync(file, "utf8"),
			ts.ScriptTarget.Latest,
			true,
			file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
		);
		checkSourceOwner(file, rendererRoot, diagnostics);
		checkComponents(file, sourceFile, diagnostics);
		checkComponentColorTokens(file, sourceFile, diagnostics);
		checkReExportBarrels(file, sourceFile, diagnostics);
		checkImportBoundaries(file, sourceFile, rendererRoot, diagnostics);
	}
	checkCssSystem(rendererRoot, diagnostics);
	return { checkedFiles: uniqueFiles.length, diagnostics };
}

function main() {
	const { rendererRoot, scopes } = parseArguments(process.argv.slice(2));
	const result = verifyRendererBoundaries(rendererRoot, scopes);
	if (result.diagnostics.length > 0) {
		console.error("Desktop renderer boundary verification failed:");
		for (const diagnostic of result.diagnostics) console.error(`  ${diagnostic}`);
		process.exitCode = 1;
		return;
	}
	console.log(`Desktop renderer boundary verification passed (${result.checkedFiles} files).`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
