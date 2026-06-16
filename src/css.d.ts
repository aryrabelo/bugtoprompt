/** Wildcard ambient declaration — tells TypeScript that any `.css` import
 *  resolves to a string (handled at build time by tsup `loader: {'.css': 'text'}`
 *  and at test time by the vitest Vite plugin in vitest.config.ts). */
declare module "*.css" {
	const content: string;
	export default content;
}
