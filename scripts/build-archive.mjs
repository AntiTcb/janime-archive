import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as cheerio from "cheerio";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const ARCHIVES_DIR = path.join(ROOT, "archives");
const PUBLIC_A = path.join(ROOT, "public", "a");
const ASSETS_DIR = path.join(PUBLIC_A, "assets");
const INDEX_OUT = path.join(ROOT, "src", "data", "archive-index.json");

const JANIME_HOST = /(?:https?:)?\/\/(?:www\.)?janime\.eu/i;
const POETS_ALCHEMY_CATEGORY = "Poet's Alchemy Stuff";

const ARCHIVE_SHELL_SCRIPT = `<script>
(function(){
	if(window.top===window.self){
		window.location.replace('/#'+window.location.pathname+window.location.search+window.location.hash);
		return;
	}
	document.addEventListener('click',function(e){
		var link=e.target.closest('a[href^="/a/"]');
		if(!link)return;
		e.preventDefault();
		parent.postMessage({type:'archive-nav',route:link.getAttribute('href')||''},location.origin);
	},true);
})();
</script>`;

/** @type {Map<string, string>} */
const assetCache = new Map();

/** @type {Map<string, { route: string, title: string, category: string, threadId: string, page: number }>} */
const routeMap = new Map();

const CHARSET_FROM_META =
	/<meta[^>]+charset\s*=\s*["']?([^"'>\s;]+)/i;
const CHARSET_FROM_CONTENT_TYPE =
	/content\s*=\s*["'][^"']*charset\s*=\s*([^"'>\s;]+)/i;

/**
 * @param {Buffer} buffer
 * @returns {string | null}
 */
function parseDeclaredCharset(buffer) {
	const head = buffer.subarray(0, Math.min(buffer.length, 16384)).toString("latin1");
	return (
		head.match(CHARSET_FROM_META)?.[1]?.toLowerCase().trim() ??
		head.match(CHARSET_FROM_CONTENT_TYPE)?.[1]?.toLowerCase().trim() ??
		null
	);
}

/**
 * @param {Buffer} buffer
 */
function isValidUtf8(buffer) {
	try {
		new TextDecoder("utf-8", { fatal: true }).decode(buffer);
		return true;
	} catch {
		return false;
	}
}

/**
 * @param {Buffer} buffer
 * @returns {string}
 */
function decodeHtmlBuffer(buffer) {
	if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
		return buffer.subarray(3).toString("utf8");
	}

	const declared = parseDeclaredCharset(buffer);
	if (declared === "utf-8" || declared === "utf8") {
		return buffer.toString("utf8");
	}

	// Saved forum pages often label ISO-8859-1 but store UTF-8 (wiki pages, mixed exports).
	if (isValidUtf8(buffer)) {
		return buffer.toString("utf8");
	}

	if (
		declared === "iso-8859-1" ||
		declared === "iso8859-1" ||
		declared === "latin1" ||
		declared === "windows-1252" ||
		declared === "cp1252"
	) {
		const label =
			declared === "windows-1252" || declared === "cp1252"
				? "windows-1252"
				: "iso-8859-1";
		return new TextDecoder(label).decode(buffer);
	}

	return buffer.toString("utf8");
}

/**
 * @param {string} filePath
 * @returns {string}
 */
function readHtmlFile(filePath) {
	return decodeHtmlBuffer(fs.readFileSync(filePath));
}

/**
 * @param {import('cheerio').CheerioAPI} $
 */
function ensureUtf8Document($) {
	$("meta[charset]").remove();
	$('meta[http-equiv="Content-Type" i]').remove();
	$('meta[http-equiv="content-type" i]').remove();
	if (!$("head").length) {
		$("html").prepend("<head></head>");
	}
	$("head").prepend('<meta charset="utf-8">');
}

/**
 * @param {string} text
 */
function decodeHtmlEntities(text) {
	return text
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) =>
			String.fromCodePoint(Number.parseInt(hex, 16)),
		)
		.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

/**
 * @param {string} text
 */
function slugify(text) {
	return text
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/['']/g, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

/**
 * @param {string} filePath
 */
function parseFilenameMeta(filePath) {
	const base = path.basename(filePath, ".htm");
	const pageMatch = base.match(/-page(\d+)$/);
	const page = pageMatch ? Number.parseInt(pageMatch[1], 10) : 1;
	const withoutPage = pageMatch ? base.slice(0, -pageMatch[0].length) : base;
	const threadIdMatch = withoutPage.match(/^(\d+)/);
	const threadId = threadIdMatch ? threadIdMatch[1] : withoutPage;
	return { base, withoutPage, threadId, page };
}

/**
 * @param {string} dir
 * @returns {string[]}
 */
function findContentPages(dir) {
	/** @type {string[]} */
	const pages = [];
	const walk = (current) => {
		for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
			const full = path.join(current, entry.name);
			if (entry.isDirectory()) {
				if (!entry.name.endsWith("_files")) walk(full);
			} else if (
				entry.isFile() &&
				/\.htm$/i.test(entry.name) &&
				!full.includes("_files")
			) {
				pages.push(full);
			}
		}
	};
	walk(dir);
	return pages.sort();
}

/**
 * @param {string} filePath
 */
function getCategory(filePath) {
	const rel = path.relative(ARCHIVES_DIR, filePath);
	return rel.split(path.sep)[0];
}

/**
 * Skip duplicate wiki saves under Janime Wiki/Janime Wiki/
 * @param {string} filePath
 */
function isDuplicateWikiCopy(filePath) {
	const rel = path.relative(ARCHIVES_DIR, filePath);
	const marker = `Janime Wiki${path.sep}Janime Wiki${path.sep}`;
	return rel.includes(marker);
}

/**
 * @param {string} filePath
 * @param {string} withoutPage
 */
function getThreadSlug(filePath, withoutPage) {
	const relDir = path.relative(ARCHIVES_DIR, path.dirname(filePath));
	const segments = relDir.split(path.sep);
	const prefix =
		segments.length > 1 ? `${segments.slice(1).join("/")}/` : "";
	return slugify(prefix + withoutPage);
}

/**
 * @param {string} buffer
 */
function hashBuffer(buffer) {
	return crypto.createHash("sha256").update(buffer).digest("hex").slice(0, 16);
}

/**
 * @param {string} srcPath
 * @param {string} ext
 */
function copyDedupedAsset(srcPath, ext) {
	const normalizedExt = ext.toLowerCase() || ".bin";
	const cacheKey = srcPath;
	if (assetCache.has(cacheKey)) {
		return assetCache.get(cacheKey);
	}
	if (!fs.existsSync(srcPath)) {
		return null;
	}
	const data = fs.readFileSync(srcPath);
	const hash = hashBuffer(data);
	const destName = `${hash}${normalizedExt.startsWith(".") ? normalizedExt : `.${normalizedExt}`}`;
	const destPath = path.join(ASSETS_DIR, destName);
	if (!fs.existsSync(destPath)) {
		fs.mkdirSync(path.dirname(destPath), { recursive: true });
		fs.copyFileSync(srcPath, destPath);
	}
	const url = `/a/assets/${destName}`;
	assetCache.set(cacheKey, url);
	return url;
}

/**
 * @param {string} category
 * @param {string} threadSlug
 * @param {number} page
 */
function buildRoute(category, threadSlug, page) {
	const catSlug = slugify(category);
	return `/a/${catSlug}/${threadSlug}/page${page}/`;
}

/**
 * @param {string} threadId
 * @param {number} page
 */
function routeKey(threadId, page) {
	return `${threadId}:${page}`;
}

/**
 * @param {string} filePath
 */
function getFilesFolderPrefix(filePath) {
	const base = path.basename(filePath, ".htm");
	return `${base}_files`;
}

/**
 * @param {string} rawUrl
 * @param {string} pageDir
 * @param {string} filesPrefix
 */
function resolveAssetPath(rawUrl, pageDir, filesPrefix) {
	if (!rawUrl || /^data:/i.test(rawUrl) || /^https?:/i.test(rawUrl)) {
		return null;
	}
	let decoded = decodeURIComponent(rawUrl.split("?")[0].split("#")[0]);
	decoded = decoded.replace(/^\.\//, "");
	if (!decoded.includes("_files") && !decoded.startsWith(filesPrefix)) {
		return null;
	}
	const candidates = [
		path.join(pageDir, decoded),
		path.join(pageDir, filesPrefix, path.basename(decoded)),
	];
	if (decoded.includes("_files/")) {
		const afterFiles = decoded.split("_files/")[1];
		candidates.push(path.join(pageDir, `${filesPrefix.split("_files")[0]}_files`, afterFiles));
		candidates.push(path.join(pageDir, filesPrefix, afterFiles));
	}
	for (const candidate of candidates) {
		if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
			return candidate;
		}
	}
	return null;
}

/**
 * @param {string} href
 * @returns {{ threadId: string, page: number } | null}
 */
function parseThreadRef(href) {
	if (!href || /^#|^javascript:/i.test(href)) return null;
	const threadId = href.match(/threads\/(\d+)/i)?.[1];
	if (!threadId) return null;
	const pageMatch = href.match(/\/page(\d+)(?:[/?#]|$)/i);
	const page = pageMatch ? Number.parseInt(pageMatch[1], 10) : 1;
	return { threadId, page };
}

/**
 * @param {string} href
 * @param {string} currentThreadId
 * @returns {string | null | undefined} rewritten href, null if dead, undefined if unchanged
 */
function rewriteHref(href, currentThreadId) {
	if (!href || href.startsWith("#") || /^javascript:/i.test(href)) {
		return undefined;
	}

	const postAnchor = href.match(/#(post\d+)/i)?.[0] ?? "";
	const parsed = parseThreadRef(href);

	if (parsed) {
		const mapped = routeMap.get(routeKey(parsed.threadId, parsed.page));
		if (mapped) return mapped.route + postAnchor;
		if (parsed.threadId === currentThreadId && postAnchor) return postAnchor;
		if (JANIME_HOST.test(href)) return null;
		return undefined;
	}

	if (JANIME_HOST.test(href)) return null;

	if (/^(forum|login|usercp|private|calendar|faq|search|album|group|profile|member)\.php/i.test(href)) {
		return null;
	}
	if (/^members\//i.test(href)) return null;

	return undefined;
}

/**
 * @param {import('cheerio').CheerioAPI} $
 * @param {import('cheerio').Element} el
 */
function neutralizeDeadLink($, el) {
	$(el).removeAttr("href");
}

/**
 * @param {import('cheerio').CheerioAPI} $
 * @param {string} pageDir
 * @param {string} filesPrefix
 */
function rewriteAssets($, pageDir, filesPrefix) {
	const attrs = ["src", "href", "background"];
	for (const el of $("[src], [href], [background]").toArray()) {
		for (const attr of attrs) {
			const val = $(el).attr(attr);
			if (!val) continue;
			const resolved = resolveAssetPath(val, pageDir, filesPrefix);
			if (resolved) {
				const ext = path.extname(resolved) || ".bin";
				const url = copyDedupedAsset(resolved, ext);
				if (url) $(el).attr(attr, url);
			}
		}
	}

	$("style").each((_, el) => {
		let css = $(el).html() || "";
		const urlPattern = /url\(['"]?([^'")]+)['"]?\)/gi;
		css = css.replace(urlPattern, (match, url) => {
			const resolved = resolveAssetPath(url, pageDir, filesPrefix);
			if (!resolved) return match;
			const ext = path.extname(resolved) || ".bin";
			const assetUrl = copyDedupedAsset(resolved, ext);
			return assetUrl ? `url('${assetUrl}')` : match;
		});
		$(el).html(css);
	});
}


/**
 * @param {string} filePath
 * @param {{ category: string, threadId: string, page: number, threadSlug: string, route: string, title: string }} meta
 */
function processPage(filePath, meta) {
	const html = readHtmlFile(filePath);
	const $ = cheerio.load(html, { decodeEntities: false });
	const pageDir = path.dirname(filePath);
	const filesPrefix = getFilesFolderPrefix(filePath);

	$("script").remove();
	$('link[href*="css.php"]').remove();
	$("link[rel='stylesheet']").each((_, el) => {
		const href = $(el).attr("href") || "";
		if (/css\.php/i.test(href)) $(el).remove();
	});

	rewriteAssets($, pageDir, filesPrefix);
	rewriteLinks($, meta.threadId);

	const posts = $("#posts");
	if (posts.length) {
		posts.attr("data-pagefind-body", "");
	} else {
		$("#content, .postlist, body").first().attr("data-pagefind-body", "");
	}

	ensureUtf8Document($);

	$("head").append(
		`<meta data-pagefind-meta="title:${meta.title.replace(/"/g, "&quot;")}" />` +
			`<meta data-pagefind-meta="category:${meta.category.replace(/"/g, "&quot;")}" />` +
			`<meta data-pagefind-meta="thread:${meta.threadId}" />` +
			`<meta data-pagefind-meta="page:${meta.page}" />` +
			ARCHIVE_SHELL_SCRIPT,
	);

	const outDir = path.join(PUBLIC_A, slugify(meta.category), meta.threadSlug, `page${meta.page}`);
	fs.mkdirSync(outDir, { recursive: true });
	fs.writeFileSync(path.join(outDir, "index.html"), $.html(), "utf8");
}

/**
 * @param {import('cheerio').CheerioAPI} $
 * @param {string} currentThreadId
 */
/**
 * @param {string} text
 */
function escapeHtml(text) {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

/**
 * @param {string} filename
 * @returns {{ title: string, page: number } | null}
 */
function parseScreenshotFilename(filename) {
	const match = filename.match(/^(.+?)(?: - Page (\d+))?_\d+\.png$/i);
	if (!match) return null;
	return {
		title: match[1].trim(),
		page: match[2] ? Number.parseInt(match[2], 10) : 1,
	};
}

/**
 * @param {string} poetsDir
 * @returns {Array<{ title: string, pages: Array<{ page: number, images: string[] }> }>}
 */
function discoverScreenshotThreads(poetsDir) {
	/** @type {Map<string, Map<number, Array<{ path: string, ts: number }>>>} */
	const byTitle = new Map();

	for (const entry of fs.readdirSync(poetsDir, { withFileTypes: true })) {
		if (!entry.isFile() || !/\.png$/i.test(entry.name)) continue;
		const parsed = parseScreenshotFilename(entry.name);
		if (!parsed) continue;
		const tsMatch = entry.name.match(/_(\d+)\.png$/i);
		const ts = tsMatch ? Number.parseInt(tsMatch[1], 10) : 0;
		const fullPath = path.join(poetsDir, entry.name);
		if (!byTitle.has(parsed.title)) byTitle.set(parsed.title, new Map());
		const byPage = byTitle.get(parsed.title);
		if (!byPage.has(parsed.page)) byPage.set(parsed.page, []);
		byPage.get(parsed.page).push({ path: fullPath, ts });
	}

	return [...byTitle.entries()]
		.map(([title, byPage]) => ({
			title,
			pages: [...byPage.entries()]
				.sort((a, b) => a[0] - b[0])
				.map(([page, items]) => ({
					page,
					images: items
						.sort((a, b) => a.ts - b.ts)
						.map((item) => item.path),
				})),
		}))
		.sort((a, b) => a.title.localeCompare(b.title));
}

/**
 * @param {{
 *   category: string,
 *   threadSlug: string,
 *   title: string,
 *   page: number,
 *   route: string,
 *   images: string[],
 *   pageRoutes: Array<{ page: number, route: string }>,
 * }} meta
 */
function processScreenshotPage(meta) {
	const imageUrls = meta.images
		.map((srcPath) => copyDedupedAsset(srcPath, path.extname(srcPath) || ".png"))
		.filter((url) => url != null);

	const nav =
		meta.pageRoutes.length > 1
			? `<nav class="screenshot-nav" aria-label="Forum pages">${meta.pageRoutes
					.map((p) =>
						p.page === meta.page
							? `<span class="screenshot-nav-current">Page ${p.page}</span>`
							: `<a href="${p.route}">Page ${p.page}</a>`,
					)
					.join(" · ")}</nav>`
			: "";

	const figures = imageUrls
		.map(
			(url) =>
				`<figure><img src="${url}" alt="" loading="lazy" decoding="async"></figure>`,
		)
		.join("\n");

	const html = `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<title>${escapeHtml(meta.title)} — page ${meta.page}</title>
	${ARCHIVE_SHELL_SCRIPT}
	<style>
		body { margin: 0; background: #1a1a2e; color: #e8e8f0; font-family: system-ui, sans-serif; line-height: 1.5; }
		.screenshot-banner { padding: 0.85rem 1rem; background: #2a2a45; border-bottom: 1px solid #3a3a55; font-size: 0.9rem; }
		.screenshot-banner h1 { margin: 0 0 0.35rem; font-size: 1.05rem; font-weight: 600; }
		.screenshot-note { color: #9898b0; font-size: 0.85rem; }
		.screenshot-nav { margin-top: 0.5rem; }
		.screenshot-nav a { color: #7eb8ff; }
		.screenshot-nav-current { color: #e8e8f0; font-weight: 600; }
		main figure { margin: 0; border-bottom: 1px solid #3a3a55; }
		main img { display: block; max-width: 100%; height: auto; margin: 0 auto; }
	</style>
</head>
<body>
	<header class="screenshot-banner">
		<h1>${escapeHtml(meta.title)}</h1>
		<p class="screenshot-note">Screenshot archive (forum page ${meta.page}) — thread text is not searchable.</p>
		${nav}
	</header>
	<main>${figures}</main>
</body>
</html>`;

	const outDir = path.join(
		PUBLIC_A,
		slugify(meta.category),
		meta.threadSlug,
		`page${meta.page}`,
	);
	fs.mkdirSync(outDir, { recursive: true });
	fs.writeFileSync(path.join(outDir, "index.html"), html, "utf8");
}

function rewriteLinks($, currentThreadId) {
	for (const attr of ["href", "action"]) {
		$(`[${attr}]`).each((_, el) => {
			const val = $(el).attr(attr);
			if (!val) return;
			const result = rewriteHref(val, currentThreadId);
			if (result === undefined) return;
			if (result === null) {
				if (attr === "href") neutralizeDeadLink($, el);
				else $(el).removeAttr(attr);
				return;
			}
			$(el).attr(attr, result);
		});
	}

	$("a[href^='javascript']").each((_, el) => {
		$(el).removeAttr("href");
	});
}

function main() {
	console.log("Building archive from", ARCHIVES_DIR);

	if (fs.existsSync(PUBLIC_A)) {
		fs.rmSync(PUBLIC_A, { recursive: true, force: true });
	}
	fs.mkdirSync(ASSETS_DIR, { recursive: true });
	fs.mkdirSync(path.dirname(INDEX_OUT), { recursive: true });

	const allPages = findContentPages(ARCHIVES_DIR);
	const pages = allPages.filter((p) => !isDuplicateWikiCopy(p));
	const skipped = allPages.length - pages.length;
	console.log(
		`Found ${allPages.length} content pages (${skipped} duplicate wiki copies skipped)`,
	);

	/** @type {Map<string, { threadSlug: string, title: string, category: string }>} */
	const threadMeta = new Map();

	for (const filePath of pages) {
		const { withoutPage, threadId, page } = parseFilenameMeta(filePath);
		const category = getCategory(filePath);
		const threadSlug = getThreadSlug(filePath, withoutPage);
		const html = readHtmlFile(filePath);
		const titleMatch = html.match(/<title>\s*(.*?)\s*<\/title>/i);
		const threadTitleMatch = html.match(
			/class="threadtitle"[^>]*>[\s\S]*?<a[^>]*>([^<]+)<\/a>/i,
		);
		const title = decodeHtmlEntities(
			(threadTitleMatch?.[1] || titleMatch?.[1] || withoutPage).trim(),
		);
		const route = buildRoute(category, threadSlug, page);

		routeMap.set(routeKey(threadId, page), {
			route,
			title,
			category,
			threadId,
			page,
		});

		if (!threadMeta.has(threadId)) {
			threadMeta.set(threadId, { threadSlug, title, category });
		}
	}

	/** @type {Record<string, { name: string, slug: string, threads: Record<string, unknown> }>} */
	const categories = {};

	for (const filePath of pages) {
		const { withoutPage, threadId, page } = parseFilenameMeta(filePath);
		const category = getCategory(filePath);
		const threadSlug = getThreadSlug(filePath, withoutPage);
		const mapped = routeMap.get(routeKey(threadId, page));
		if (!mapped) continue;

		const catSlug = slugify(category);
		if (!categories[catSlug]) {
			categories[catSlug] = { name: category, slug: catSlug, threads: {} };
		}
		const cat = categories[catSlug];
		if (!cat.threads[threadId]) {
			const tm = threadMeta.get(threadId);
			cat.threads[threadId] = {
				threadId,
				title: tm?.title || mapped.title,
				slug: tm?.threadSlug || threadSlug,
				pages: [],
			};
		}
		cat.threads[threadId].pages.push({
			page,
			route: mapped.route,
			title: mapped.title,
		});
	}

	for (const filePath of pages) {
		const { withoutPage, threadId, page } = parseFilenameMeta(filePath);
		const category = getCategory(filePath);
		const threadSlug = getThreadSlug(filePath, withoutPage);
		const mapped = routeMap.get(routeKey(threadId, page));
		if (!mapped) continue;

		processPage(filePath, {
			category,
			threadId,
			page,
			threadSlug,
			route: mapped.route,
			title: mapped.title,
		});
	}

	const poetsDir = path.join(ARCHIVES_DIR, POETS_ALCHEMY_CATEGORY);
	/** @type {Array<{ title: string, pages: Array<{ page: number, images: string[] }> }>} */
	const screenshotThreads = fs.existsSync(poetsDir)
		? discoverScreenshotThreads(poetsDir)
		: [];
	let screenshotPageCount = 0;

	for (const thread of screenshotThreads) {
		const threadId = `shot-${slugify(thread.title)}`;
		const threadSlug = slugify(thread.title);
		const pageRoutes = thread.pages.map((p) => ({
			page: p.page,
			route: buildRoute(POETS_ALCHEMY_CATEGORY, threadSlug, p.page),
		}));

		for (const pageEntry of thread.pages) {
			const route = buildRoute(
				POETS_ALCHEMY_CATEGORY,
				threadSlug,
				pageEntry.page,
			);
			routeMap.set(routeKey(threadId, pageEntry.page), {
				route,
				title: thread.title,
				category: POETS_ALCHEMY_CATEGORY,
				threadId,
				page: pageEntry.page,
			});
		}

		const catSlug = slugify(POETS_ALCHEMY_CATEGORY);
		if (!categories[catSlug]) {
			categories[catSlug] = {
				name: POETS_ALCHEMY_CATEGORY,
				slug: catSlug,
				threads: {},
			};
		}
		categories[catSlug].threads[threadId] = {
			threadId,
			title: thread.title,
			slug: threadSlug,
			screenshotArchive: true,
			pages: pageRoutes.map((p) => ({
				page: p.page,
				route: p.route,
				title: thread.title,
			})),
		};

		for (const pageEntry of thread.pages) {
			processScreenshotPage({
				category: POETS_ALCHEMY_CATEGORY,
				threadSlug,
				title: thread.title,
				page: pageEntry.page,
				route: buildRoute(POETS_ALCHEMY_CATEGORY, threadSlug, pageEntry.page),
				images: pageEntry.images,
				pageRoutes,
			});
			screenshotPageCount += 1;
		}
	}

	if (screenshotThreads.length) {
		console.log(
			`Poet's Alchemy screenshots: ${screenshotThreads.length} threads, ${screenshotPageCount} viewer pages`,
		);
	}

	const finalIndex = {
		categories: Object.values(categories)
			.map((cat) => ({
				...cat,
				threads: Object.values(cat.threads).map((t) => ({
					...t,
					pages: t.pages.sort((a, b) => a.page - b.page),
				})),
			}))
			.sort((a, b) => a.name.localeCompare(b.name)),
	};

	fs.writeFileSync(INDEX_OUT, JSON.stringify(finalIndex, null, 2), "utf8");

	const assetCount = fs.readdirSync(ASSETS_DIR).length;
	const pageCount = pages.length + screenshotPageCount;
	const totalFiles = pageCount + assetCount;

	console.log("\n--- Build summary ---");
	console.log(`HTML pages:        ${pages.length}`);
	if (screenshotPageCount) {
		console.log(`Screenshot pages:  ${screenshotPageCount}`);
	}
	console.log(`Pages written:     ${pageCount}`);
	console.log(`Unique assets:     ${assetCount}`);
	console.log(`Total deploy files: ${totalFiles} (+ app shell + pagefind)`);
	console.log(`Workers free limit: 20,000 | paid: 100,000`);
	if (totalFiles > 20000) {
		console.warn(
			`WARNING: ${totalFiles} files exceed free tier (20k). Use Workers Paid or R2 for assets.`,
		);
	} else {
		console.log("Within Workers free tier file limit.");
	}
	console.log(`Index written to ${INDEX_OUT}`);
}

main();
