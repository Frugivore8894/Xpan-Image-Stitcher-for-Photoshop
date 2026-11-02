// xpan_stitch_photoshop.jsx
// Batch-stitch X-Pan half-scans with Photoshop's Photomerge.
// Works with RAW (ARW, DNG, NEF, CR2, ...), TIFF, JPEG, PNG and PSD.
// Pairs are taken in filename order: 1+2, 3+4, 5+6 ...
//
// Run:  Photoshop > File > Scripts > Browse...  > pick this file.
// You'll be asked for the input folder and the output folder.
//
// RAW files are first opened with Camera Raw using the camera's own settings
// (no dialog), saved as temporary 16-bit TIFFs, then merged. The temp files are
// deleted afterwards.

// ----------------------------- SETTINGS -----------------------------
// Photomerge "layout" (how the halves are positioned):
//   "translation"   = Reposition   (no warping; best for flat scans of the same strip)
//   "sceneCollage"  = Collage      (rotates/scales to fit, no perspective warp)
//   "Auto"          = Auto
//   "Prsp"          = Perspective
//   "cylindrical"   = Cylindrical
//   "spherical"     = Spherical
// If Photomerge fails with MODE, the script automatically retries with FALLBACK_MODES.
var MODE = "translation";
var FALLBACK_MODES = ["sceneCollage", "Auto"];

var BLEND_IMAGES         = true;   // "Blend Images Together" (seam blending / colour matching)
var VIGNETTE_REMOVAL     = false;  // can help if the halves have light falloff at the edges
var GEOMETRIC_DISTORTION = false;  // "Geometric Distortion Correction"; leave off for flat scans
var CONTENT_AWARE_FILL   = false;  // fill transparent edges with Content-Aware Fill (if supported)
var CROP_TO_CONTENT      = true;   // trim transparent edges (ignored if CONTENT_AWARE_FILL is true)

var OUTPUT_FORMAT = "tif";         // "tif" (LZW, keeps 16-bit) or "jpg"
var JPEG_QUALITY  = 12;            // 0-12
// --------------------------------------------------------------------

// Photomerge.jsx (Adobe's own script) checks this flag and, when it is true, loads
// without opening its dialog so that we can drive it. Must be set before it is loaded.
var runphotomergeFromScript = true;

#target photoshop

var RAW_RE = /\.(arw|dng|nef|nrw|cr2|cr3|raf|orf|rw2|pef|srw)$/i;
var IMG_RE = /\.(tif|tiff|jpg|jpeg|png|psd)$/i;

function isRaw(f)   { return RAW_RE.test(f.name); }
function isImage(f) { return isRaw(f) || IMG_RE.test(f.name); }

function naturalCompare(a, b) {
    var ax = a.name.toLowerCase().match(/(\d+|\D+)/g) || [];
    var bx = b.name.toLowerCase().match(/(\d+|\D+)/g) || [];
    for (var i = 0; i < Math.min(ax.length, bx.length); i++) {
        var x = ax[i], y = bx[i];
        if (/^\d+$/.test(x) && /^\d+$/.test(y)) {
            var d = parseInt(x, 10) - parseInt(y, 10);
            if (d !== 0) return d;
        } else if (x !== y) {
            return x < y ? -1 : 1;
        }
    }
    return ax.length - bx.length;
}

function stemOf(f) { return f.name.replace(/\.[^.]+$/, ""); }

// Open a RAW file with Camera Raw using the camera's settings, without showing the dialog,
// and save it as a temporary 16-bit TIFF that Photomerge can read.
function rawToTempTiff(file, tag) {
    var opts = new CameraRAWOpenOptions();
    try { opts.settings = CameraRAWSettings.CAMERA; } catch (e1) {}
    try { opts.bitsPerChannel = BitsPerChannelType.SIXTEEN; } catch (e2) {}
    try { opts.colorSpace = ColorSpaceType.SRGB; } catch (e3) {}

    var doc;
    try {
        doc = app.open(file, opts);
    } catch (e4) {
        doc = app.open(file);   // fall back to a plain open
    }
    if (doc.bitsPerChannel !== BitsPerChannelType.SIXTEEN) {
        doc.bitsPerChannel = BitsPerChannelType.SIXTEEN;
    }
    var tmp = new File(Folder.temp + "/xpan_ps_tmp_" + tag + ".tif");
    var t = new TiffSaveOptions();
    t.imageCompression = TIFFEncoding.NONE;
    t.layers = false;
    t.embedColorProfile = true;
    doc.saveAs(tmp, t, true, Extension.LOWERCASE);
    doc.close(SaveOptions.DONOTSAVECHANGES);
    return tmp;
}

// ---------------------------------------------------------------------------
// Photomerge is implemented by a JavaScript file that ships with Photoshop
// (Presets/Scripts/Photomerge.jsx). We load it and call its createPanorama().
// ---------------------------------------------------------------------------
function loadPhotomerge(info) {
    if (typeof photomerge !== "undefined" && photomerge && photomerge.createPanorama) return true;

    var presets = new Folder(app.path + "/" + localize("$$$/ScriptingSupport/InstalledScripts=Presets/Scripts"));
    var candidates = [
        new File(presets + "/Photomerge.jsx"),
        new File(app.path + "/Presets/Scripts/Photomerge.jsx")
    ];
    // also look for any file with "photomerge" in its name (in case a version renamed it)
    if (presets.exists) {
        var listing = presets.getFiles();
        for (var i = 0; i < listing.length; i++) {
            if (/photomerge/i.test(listing[i].name)) candidates.push(listing[i]);
        }
        var names = [];
        for (var j = 0; j < listing.length && j < 60; j++) names.push(listing[j].name);
        info.push("Presets/Scripts folder: " + presets.fsName + "  (" + names.join(", ") + ")");
    } else {
        info.push("Presets/Scripts folder not found at: " + presets.fsName);
    }

    var tried = {};
    for (var c = 0; c < candidates.length; c++) {
        var f = candidates[c];
        if (!f.exists || tried[f.fsName]) continue;
        tried[f.fsName] = true;
        try {
            info.push("Loading " + f.fsName);
            $.evalFile(f);
            if (typeof photomerge !== "undefined" && photomerge && photomerge.createPanorama) return true;
            info.push("  loaded, but no usable 'photomerge' object was defined");
        } catch (e) {
            info.push("  failed to load: " + e.message + " (line " + e.line + ")");
        }
    }
    return false;
}

function describePhotomerge() {
    var out = [];
    try { for (var k in photomerge) out.push(k + ":" + typeof photomerge[k]); } catch (e) {}
    return out.join(", ");
}

// Applies our settings to the photomerge object, only touching properties that exist.
function configurePhotomerge(mode) {
    photomerge.alignmentKey    = mode;
    photomerge.advancedBlending = BLEND_IMAGES;
    photomerge.removeVignette  = VIGNETTE_REMOVAL;
    photomerge.lensCorrection  = GEOMETRIC_DISTORTION;
    var caf = ["contentAwareFillTransparent", "contentAwareFill", "contentAware", "fillTransparentAreas"];
    for (var i = 0; i < caf.length; i++) {
        if (caf[i] in photomerge) { photomerge[caf[i]] = CONTENT_AWARE_FILL; }
    }
}

function noteError(state, msg, mode) {
    if (!state.errors[msg]) { state.errors[msg] = { n: 0, first: mode }; state.order.push(msg); }
    state.errors[msg].n++;
}

// Returns true when a merged document was produced.
function photomergePair(fileA, fileB, modes, startDocs, state) {
    for (var i = 0; i < modes.length; i++) {
        try {
            configurePhotomerge(modes[i]);
            photomerge.createPanorama([fileA, fileB], false);
            if (app.documents.length > startDocs) { state.usedMode = modes[i]; return true; }
            noteError(state, "no document was produced", modes[i]);
        } catch (e) {
            noteError(state, String(e.message) + " (line " + e.line + ")", modes[i]);
            closeExtraDocs(startDocs);
        }
    }
    return false;
}

function saveResult(doc, outFile) {
    if (OUTPUT_FORMAT === "jpg") {
        if (doc.bitsPerChannel !== BitsPerChannelType.EIGHT) {
            doc.bitsPerChannel = BitsPerChannelType.EIGHT;
        }
        var j = new JPEGSaveOptions();
        j.quality = JPEG_QUALITY;
        j.embedColorProfile = true;
        j.formatOptions = FormatOptions.OPTIMIZEDBASELINE;
        doc.saveAs(outFile, j, true, Extension.LOWERCASE);
    } else {
        var t = new TiffSaveOptions();
        t.imageCompression = TIFFEncoding.TIFFLZW;
        t.layers = false;
        t.embedColorProfile = true;
        doc.saveAs(outFile, t, true, Extension.LOWERCASE);
    }
}

function closeExtraDocs(keep) {
    while (app.documents.length > keep) {
        app.activeDocument.close(SaveOptions.DONOTSAVECHANGES);
    }
}

function removeFile(f) { try { if (f && f.exists) f.remove(); } catch (e) {} }

function main() {
    var inFolder = Folder.selectDialog("Select the folder with your half-frame scans");
    if (!inFolder) return;
    var outFolder = Folder.selectDialog("Select the folder for stitched images");
    if (!outFolder) return;

    // list files (manual filter: more reliable than a filter callback across platforms)
    var all = inFolder.getFiles();
    var files = [];
    var seenExt = {};
    for (var i = 0; i < all.length; i++) {
        var f = all[i];
        if (!(f instanceof File) || f.name.charAt(0) === ".") continue;
        var m = f.name.match(/\.([^.]+)$/);
        if (m) seenExt[m[1].toLowerCase()] = true;
        if (isImage(f)) files.push(f);
    }
    files.sort(naturalCompare);

    if (files.length < 2) {
        var found = [];
        for (var k in seenExt) found.push("." + k);
        alert("Found " + files.length + " usable image(s) in:\n" + inFolder.fsName +
              "\n\nFile types in that folder: " + (found.length ? found.join(", ") : "none") +
              "\n\nSupported: RAW (arw, dng, nef, cr2, cr3, raf, orf, rw2, pef), tif, jpg, png, psd.\n" +
              "Make sure you picked the folder that directly contains the files.");
        return;
    }
    var warning = "";
    if (files.length % 2 !== 0) {
        warning = "\n\nNOTE: odd number of files; the last one was skipped (" +
                  files[files.length - 1].name + "). Check for a missing half.";
        files.pop();
    }

    var modes = [MODE];
    for (var q = 0; q < FALLBACK_MODES.length; q++) {
        if (FALLBACK_MODES[q] !== MODE) modes.push(FALLBACK_MODES[q]);
    }

    var pairs = files.length / 2;
    var win = null;
    try {
        win = new Window("palette", "X-Pan stitching");
        win.st = win.add("statictext", undefined, "Starting...");
        win.st.preferredSize.width = 380;
        win.pb = win.add("progressbar", undefined, 0, pairs);
        win.pb.preferredSize.width = 380;
        win.show();
    } catch (eW) { win = null; }

    var pmState = { usedMode: null, errors: {}, order: [] };
    var loadInfo = [];
    var oldDialogs = app.displayDialogs;
    app.displayDialogs = DialogModes.NO;

    if (!loadPhotomerge(loadInfo)) {
        app.displayDialogs = oldDialogs;
        if (win) { try { win.close(); } catch (eC0) {} }
        var lf = new File(outFolder + "/xpan_photoshop_debug.txt");
        try {
            lf.open("w");
            lf.writeln("Could not load Photoshop's Photomerge.jsx");
            lf.writeln("Photoshop version: " + app.version + "   build: " + app.build + "   OS: " + $.os);
            lf.writeln("app.path: " + app.path);
            for (var li = 0; li < loadInfo.length; li++) lf.writeln(loadInfo[li]);
            lf.close();
        } catch (eLf) {}
        alert("Could not load Photoshop's built-in Photomerge script (Presets/Scripts/Photomerge.jsx).\n\n" +
              loadInfo.join("\n") + "\n\nDetails were saved to:\n" + lf.fsName);
        return;
    }
    var startDocs = app.documents.length;
    var failed = [];
    var ok = 0;
    var stoppedEarly = false;
    var log = [];

    for (var p = 0; p < pairs; p++) {
        var a = files[p * 2], b = files[p * 2 + 1];
        var temps = [];
        var stage = "start";
        if (win) {
            win.st.text = "Pair " + (p + 1) + " of " + pairs + ":  " + a.name + " + " + b.name;
            win.pb.value = p;
            win.update();
        }
        try {
            var srcA = a, srcB = b;
            stage = "Camera Raw conversion";
            if (isRaw(a)) { srcA = rawToTempTiff(a, "A" + p); temps.push(srcA); }
            if (isRaw(b)) { srcB = rawToTempTiff(b, "B" + p); temps.push(srcB); }
            stage = "Photomerge";

            log.push("Pair " + (p + 1) + ": " + a.name + " + " + b.name);
            log.push("  temp A: " + srcA.fsName + "  exists=" + srcA.exists + "  bytes=" + srcA.length);
            log.push("  temp B: " + srcB.fsName + "  exists=" + srcB.exists + "  bytes=" + srcB.length);
            if (!photomergePair(srcA, srcB, modes, startDocs, pmState)) {
                throw new Error("Photomerge failed in every layout (see debug log)");
            }

            stage = "trim/flatten/save";
            var doc = app.activeDocument;
            if (CROP_TO_CONTENT && !CONTENT_AWARE_FILL) {
                doc.trim(TrimType.TRANSPARENT, true, true, true, true);
            }
            doc.flatten();
            saveResult(doc, new File(outFolder + "/" + stemOf(a) + "_stitched." + OUTPUT_FORMAT));
            ok++;
        } catch (e) {
            failed.push(a.name + " + " + b.name + "  [" + stage + "] " + e.message);
        }
        closeExtraDocs(startDocs);
        for (var t = 0; t < temps.length; t++) removeFile(temps[t]);
        if (ok === 0 && (failed.length >= 2 || (failed.length >= 1 && stage === "Photomerge"))) {
            stoppedEarly = true;   // nothing works yet - no point continuing
            break;
        }
    }

    app.displayDialogs = oldDialogs;
    if (win) { try { win.close(); } catch (eC) {} }

    // debug log (always written, so problems can be diagnosed without guessing)
    var logFile = new File(outFolder + "/xpan_photoshop_debug.txt");
    try {
        logFile.encoding = "UTF-8";
        logFile.open("w");
        logFile.writeln("X-Pan Photoshop script debug log");
        logFile.writeln("Photoshop version: " + app.version + "   build: " + app.build);
        logFile.writeln("OS: " + $.os);
        logFile.writeln("Settings: MODE=" + MODE + " BLEND=" + BLEND_IMAGES + " CONTENT_AWARE=" + CONTENT_AWARE_FILL);
        logFile.writeln("Pairs processed: " + (ok + failed.length) + " of " + pairs + "   succeeded: " + ok);
        logFile.writeln("Last layout that worked: " + (pmState.usedMode || "NONE"));
        for (var q2 = 0; q2 < loadInfo.length; q2++) logFile.writeln(loadInfo[q2]);
        logFile.writeln("photomerge object members: " + describePhotomerge());
        logFile.writeln("");
        logFile.writeln("Distinct errors from Photomerge attempts (count, first layout that produced it):");
        for (var z = 0; z < pmState.order.length && z < 25; z++) {
            var em = pmState.order[z];
            logFile.writeln("  x" + pmState.errors[em].n + "  layout=" + pmState.errors[em].first);
            logFile.writeln("      " + em.replace(/\n/g, "\n      "));
        }
        logFile.writeln("");
        for (var y = 0; y < log.length; y++) logFile.writeln(log[y]);
        for (var w2 = 0; w2 < failed.length; w2++) logFile.writeln("FAILED: " + failed[w2]);
        logFile.close();
    } catch (eL) {}

    var msg = "Stitched " + ok + " of " + pairs + " pairs.\nSaved to: " + outFolder.fsName + warning;
    if (pmState.usedMode) msg += "\n\nPhotomerge layout used: " + pmState.usedMode;
    if (stoppedEarly) msg += "\n\nStopped early because Photomerge could not be run. A debug log was saved to:\n" + logFile.fsName;
    if (failed.length) msg += "\n\nFailed (" + failed.length + (failed.length > 4 ? ", first 4 shown" : "") + "):\n" + failed.slice(0, 4).join("\n");
    alert(msg);
}

// Safety net: if anything unexpected goes wrong, say so and leave a log on the Desktop.
try {
    main();
} catch (fatal) {
    var msgFatal = "The script stopped unexpectedly:\n\n" + fatal.message + "\n(line " + fatal.line + ")";
    try {
        var crashLog = new File(Folder.desktop + "/xpan_photoshop_crash.txt");
        crashLog.open("w");
        crashLog.writeln("X-Pan Photoshop script crashed");
        crashLog.writeln("Photoshop " + app.version + "  " + $.os);
        crashLog.writeln(fatal.message + "  (line " + fatal.line + ")");
        crashLog.writeln(String(fatal.stack || ""));
        crashLog.close();
        msgFatal += "\n\nDetails saved to: " + crashLog.fsName;
    } catch (eCrash) {}
    try { app.displayDialogs = DialogModes.ALL; } catch (eDlg) {}
    alert(msgFatal);
}
