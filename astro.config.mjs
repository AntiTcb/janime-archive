// @ts-check
import { defineConfig } from "astro/config";

/** @type {import("vite").Connect.NextHandleFunction} */
const archiveIndexMiddleware = (req, _res, next) => {
	if (!req.url) return next();
	const [pathname, search = ""] = req.url.split("?");
	if (
		pathname.startsWith("/a/") &&
		(pathname.endsWith("/") || !pathname.includes("."))
	) {
		const base = pathname.endsWith("/") ? pathname : `${pathname}/`;
		req.url = `${base}index.html${search ? `?${search}` : ""}`;
	}
	next();
};

/** @returns {import("vite").Plugin} */
const archiveDirectoryIndex = () => ({
	name: "archive-directory-index",
	configureServer(server) {
		server.middlewares.use(archiveIndexMiddleware);
	},
	configurePreviewServer(server) {
		server.middlewares.use(archiveIndexMiddleware);
	},
});

// https://astro.build/config
export default defineConfig({
	site: "https://arynis-archive.workers.dev",
	trailingSlash: "always",
	build: {
		format: "directory",
	},
	vite: {
		plugins: [archiveDirectoryIndex()],
	},
});
