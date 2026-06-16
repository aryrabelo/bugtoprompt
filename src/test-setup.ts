import "fake-indexeddb/auto";

/**
 * Test environment polyfills — runs before every test file in the jsdom
 * environment. Patches `Blob.prototype.arrayBuffer` when jsdom ships a Blob
 * build that omits it (the method is defined in the WHATWG Blob spec but some
 * jsdom versions skip the impl).
 */
if (
	typeof Blob !== "undefined" &&
	typeof Blob.prototype.arrayBuffer !== "function"
) {
	Blob.prototype.arrayBuffer = function (this: Blob): Promise<ArrayBuffer> {
		const { promise, resolve, reject } = Promise.withResolvers<ArrayBuffer>();
		const reader = new FileReader();
		reader.onload = () => resolve(reader.result as ArrayBuffer);
		reader.onerror = () => reject(new Error("FileReader error"));
		reader.readAsArrayBuffer(this);
		return promise;
	};
}
