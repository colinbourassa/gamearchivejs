/**
 * @file Doom .WAD format handler.
 *
 * This file format is fully documented on the ModdingWiki:
 *   http://www.shikadi.net/moddingwiki/WAD_Format
 *
 * Copyright (C) 2018-2019 Adam Nielsen <malvineous@shikadi.net>
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

const { RecordBuffer, RecordType } = require('@malvineous/record-io-buffer');

const ArchiveHandler = require('./archiveHandler.js');
const Archive = require('./archive.js');
const Debug = require('../util/utl-debug.js');

const FORMAT_ID = 'arc-wad-doom';
const MAX_FILENAME_LEN = 8;
const MAX_FOLDERNAME_LEN = MAX_FILENAME_LEN - 6; // length of "_START"

const recordTypes = {
	header: {
		signature: RecordType.string.fixed.noTerm(4),
		fileCount: RecordType.int.u32le, // TODO: should be signed?
		fatOffset: RecordType.int.u32le,
	},
	fatEntry: {
		offset: RecordType.int.u32le,
		size: RecordType.int.u32le,
		name: RecordType.string.fixed.optTerm(8),
	},
};

const HEADER_LEN = 12; // sizeof(header)
const FATENTRY_LEN = 16; // sizeof(fatEntry)

function isLevel(name) {
	return (
		(
			(name[0] === 'E')
			&& (name[2] === 'M')
		) || (
			(name.length === 5)
			&& (name.substr(0, 3) === 'MAP')
		)
	);
}

const levelEntryOrder = [
	'THINGS',
	'LINEDEFS',
	'SIDEDEFS',
	'VERTEXES',
	'SEGS',
	'SSECTORS',
	'NODES',
	'SECTORS',
	'REJECT',
	'BLOCKMAP',
	'BEHAVIOR',
];

module.exports = class Archive_WAD_Doom extends ArchiveHandler
{
	static metadata() {
		let md = {
			...super.metadata(),
			id: FORMAT_ID,
			title: 'WAD File',
			games: [
				'Doom',
			],
			glob: [
				'*.wad',
			],
		};

		// No filename length set here because we are using virtual folders, and
		// these cause the total filename length to exceed the limit.
		//md.limits.maxFilenameLen = 8;

		return md;
	}

	static checkLimits(archive)
	{
		let issues = super.checkLimits(archive);

		// We can't check the length of the total filename (with any virtual
		// folders) because that will often be too long, so instead we need to split
		// it up into filenames and folder names and check the length of those
		// individually.
		archive.files.forEach(file => {
			const parts = file.name.split('/');
			parts.forEach((p, i) => {
				if (i === parts.length - 1) {
					// Last component, a filename
					if (p.length > MAX_FILENAME_LEN) {
						issues.push(`Filename length is ${p.length}, max is `
							+ `${MAX_FILENAME_LEN}: ${p}`);
					}
				} else {
					// Other component, a folder name
					if (isLevel(p)) {
						// E1M1 etc.
						return;
					}
					if (p.length > MAX_FOLDERNAME_LEN) { // length of "_START"
						issues.push(`Folder name length is ${p.length}, max is `
							+ `${MAX_FOLDERNAME_LEN}: ${p}`);
					}
				}
			});
		});

		return issues;
	}

	static identify(content) {
		try {
			Debug.push(FORMAT_ID, 'identify');

			const lenArchive = content.length;

			if (lenArchive < HEADER_LEN) {
				Debug.log(`Content too short (< ${HEADER_LEN} b) => false`);
				return false;
			}

			let buffer = new RecordBuffer(content);
			const header = buffer.readRecord(recordTypes.header);

			if (
				(header.signature != 'IWAD')
				&& (header.signature != 'PWAD')
			) {
				Debug.log(`Incorrect signature "${header.signature}" => false`);
				return false;
			}

			if (header.fatOffset > lenArchive) {
				Debug.log(`FAT offset (${header.fatOffset}) is past the end of the `
					+ `file (${lenArchive}) => false`);
				return false;
			}

			Debug.log(`Header OK => true`);
			return true;

		} finally {
			Debug.pop();
		}
	}

	static parse({main: content}) {
		let archive = new Archive();
		let buffer = new RecordBuffer(content);

		const header = buffer.readRecord(recordTypes.header);

		buffer.seekAbs(header.fatOffset);
		let folder = [], folderPrefix = '';

		let inLevel = false;
		for (let i = 0; i < header.fileCount; i++) {
			const fatEntry = buffer.readRecord(recordTypes.fatEntry);

			const isStart = (fatEntry.size === 0) && (fatEntry.name.substr(-6) === '_START');
			const isStartMap =
				(fatEntry.size === 0)
				&& (fatEntry.name.length === 4)
				&& isLevel(fatEntry.name)
			;
			const isEndMap =
				inLevel
				&& (levelEntryOrder.find(e => e === fatEntry.name) === undefined)
			;
			const isEnd =
				(fatEntry.size === 0)
				&& fatEntry.name.substr(-4) === '_END'
			;
			if (isStartMap) {
				inLevel = true;
			} else if (isEndMap) {
				inLevel = false;
			}

			// Do this first so E1M1 ends before E1M2 starts, which results in
			// both isStartMap and isEndMap both being true.
			if (isEnd || isEndMap) {
				folder.pop();
			}

			if (isStart) {
				folder.push(fatEntry.name.substr(0, fatEntry.name.length - 6));
			} else if (isStartMap) {
				folder.push(fatEntry.name);
			}

			// Update the folder prefix if it has changed.
			if (isStart || isEnd || isStartMap || isEndMap) {
				folderPrefix = folder.join('/');
				if (folderPrefix.length > 0) folderPrefix += '/';
			}

			// These files we don't want to include
			if (isStart || isStartMap || isEnd) continue;

			let file = new Archive.File();
			file.name = folderPrefix + fatEntry.name;
			file.diskSize = file.nativeSize = fatEntry.size;
			file.offset = fatEntry.offset;
			file.getRaw = () => buffer.getU8(file.offset, file.diskSize);

			archive.files.push(file);
		}

		return archive;
	}

	static generate(archive)
	{
		// Group entries by folder
		let groupedFiles = {};
		archive.files.forEach(file => {
			let target = groupedFiles;
			let path = file.name.split('/');
			while (path.length > 1) {
				const c = path.shift();
				if (!target[c]) target[c] = {};
				target = target[c];
			}
			target[path[0]] = {
				shortName: path[0],
				file: file,
			};
		});

		// Turn the grouped list into a flat one with the correct start/end entries.
		let flatList = [];
		const flatten = (list, level) => {
			let keys = Object.keys(list);
			if (level) {
				// Sort the keys into the expected format
				keys.sort((a, b) => {
					return levelEntryOrder.indexOf(a) - levelEntryOrder.indexOf(b);
				});
			}
			keys.forEach(name => {
				const entry = list[name];
				if (entry.file) {
					const newFile = {
						...entry.file,
						name: entry.shortName,
					};
					flatList.push(newFile);
				} else {
					let startEntry = new Archive.File();
					const level = isLevel(name);
					if (level) {
						startEntry.name = name;
					} else {
						startEntry.name = name + '_START';
					}
					startEntry.nativeSize = 0;
					startEntry.getRaw = () => new Uint8Array();
					flatList.push(startEntry);

					flatten(entry, level);

					if (!level) {
						let endEntry = new Archive.File();
						endEntry.name = name + '_END';
						endEntry.nativeSize = 0;
						endEntry.getRaw = () => new Uint8Array();
						flatList.push(endEntry);
					}
				}
			});
		};
		flatten(groupedFiles);

		const header = {
			signature: 'IWAD',
			fileCount: flatList.length,
			fatOffset: HEADER_LEN,
		};

		// Work out where the FAT ends and the first file starts.
		const lenFAT = HEADER_LEN + FATENTRY_LEN * header.fileCount;

		// Calculate the size up front so we don't have to keep reallocating the
		// buffer, improving performance.
		const finalSize = flatList.reduce(
			(a, b) => a + (b.nativeSize || 0),
			lenFAT,
		);

		let buffer = new RecordBuffer(finalSize);
		buffer.writeRecord(recordTypes.header, header);
		let offset = lenFAT;
		flatList.forEach(file => {
			const entry = {
				name: file.name,
				size: file.nativeSize,
				offset: offset,
			};
			buffer.writeRecord(recordTypes.fatEntry, entry);
			offset += file.nativeSize;
		});

		flatList.forEach(file => {
			const content = file.getContent();

			// Safety check.
			if (content.length != file.nativeSize) {
				throw new Error('Length of data and nativeSize field do not match!');
			}

			buffer.put(content);
		});

		return {
			main: buffer.getU8(),
		};
	}
};
