const assert = require('assert');
const fs = require('fs');

function hexdump(d) {
	let s = '', h = '', t = '';
	for (let i = 0; i < d.length; i++) {
		let v = d.readUInt8(i);
		h += v.toString(16).padStart(2, '0') + ' ';
		t += ((v < 32) || (v > 126)) ? '.' : String.fromCharCode(v);
		if (i % 16 === 15) {
			s += (i - 15).toString(16).padStart(6, '0') + '  ' + h + '  ' + t + "\n";
			h = t = '';
		}
	}
	return s;
}

module.exports = class TestUtil {
	constructor(idHandler) {
		assert.ok(idHandler, 'Format handler ID must be specified');
		this.idHandler = idHandler;
	}

	buffersEqual(expected, actual) {
		if ((expected.length != actual.length) || expected.compare(actual)) {
			throw new assert.AssertionError({
				message: 'Buffers are not equal',
				expected: hexdump(expected),
				actual: hexdump(actual),
			});
		}
	}

	loadData(filename) {
		return fs.readFileSync(`${__dirname}/${this.idHandler}/${filename}`);
	}
};