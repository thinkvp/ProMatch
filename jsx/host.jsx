/*
 * host.jsx — the ONLY code that touches Premiere Pro.
 *
 * Contract (same as Interviewed): every entry point takes one JSON string and
 * returns one JSON string,
 *   { "ok": true,  "data": <anything> }
 *   { "ok": false, "error": "message", "line": 123 }
 *
 * ES3 discipline: no const/let, arrows, forEach/map/indexOf or trim. A syntax
 * error here produces a silent panel, which is why PM_ping is also the load
 * sentinel the panel checks for.
 *
 * QE DOM (app.enableQE / qe.*) is undocumented. Everything that uses it is
 * listed in spikes/SPIKES.md with what is and is not verified.
 */

function _pmOk(data) {
    return JSON.stringify({ ok: true, data: data });
}

function _pmErr(e) {
    var msg = (e && e.message) ? e.message : String(e);
    return JSON.stringify({ ok: false, error: msg, line: (e && e.line) ? e.line : null });
}

function _pmParse(s) {
    if (!s) return {};
    return JSON.parse(s);
}

function _pmWrap(fn, argJson) {
    try {
        return _pmOk(fn(_pmParse(argJson)));
    } catch (e) {
        return _pmErr(e);
    }
}

function _pmTicks(t) {
    return parseFloat(t.ticks);
}

/** Topmost visible video clip under the playhead — what the frame shows. */
function _pmClipAtPlayhead(seq) {
    if (!seq) return null;
    var pos = _pmTicks(seq.getPlayerPosition());
    for (var t = seq.videoTracks.numTracks - 1; t >= 0; t--) {
        var track = seq.videoTracks[t];
        if (typeof track.isMuted === "function" && track.isMuted()) continue;
        for (var c = 0; c < track.clips.numItems; c++) {
            var clip = track.clips[c];
            if (_pmTicks(clip.start) <= pos && pos < _pmTicks(clip.end)) {
                var multicam = false;
                try {
                    multicam = !!(clip.projectItem && clip.projectItem.isMulticamClip && clip.projectItem.isMulticamClip());
                } catch (e1) {}
                return { name: clip.name, track: t + 1, multicam: multicam };
            }
        }
    }
    return null;
}

/** Selected VIDEO track items with the indices QE needs to find them again. */
function _pmSelectedVideo(seq) {
    var out = [];
    if (!seq) return out;
    for (var t = 0; t < seq.videoTracks.numTracks; t++) {
        var track = seq.videoTracks[t];
        for (var c = 0; c < track.clips.numItems; c++) {
            var clip = track.clips[c];
            if (clip.isSelected()) out.push({ clip: clip, track: t, index: c });
        }
    }
    return out;
}

/** The QE item for DOM clip #index on video track #track. QE interleaves
 *  "Empty" gap items, so count only real ones. */
function _pmQeItem(track, index) {
    var qt = qe.project.getActiveSequence().getVideoTrackAt(track);
    var k = -1;
    for (var i = 0; i < qt.numItems; i++) {
        var it = qt.getItemAt(i);
        if (it && it.type !== "Empty") {
            k++;
            if (k === index) return it;
        }
    }
    return null;
}

function _pmLastLumetri(clip) {
    var found = null;
    for (var i = 0; i < clip.components.numItems; i++) {
        var comp = clip.components[i];
        if (String(comp.matchName).indexOf("Lumetri") !== -1) found = comp;
    }
    return found;
}

/* ------------------------------------------------------------ entry points */

function PM_ping() {
    return _pmWrap(function () {
        var seq = app.project ? app.project.activeSequence : null;
        return {
            app: app.name || "Premiere Pro",
            version: app.version,
            hasActiveSequence: !!seq,
            sequence: seq ? seq.name : null
        };
    }, "");
}

/** The open project's .prproj path — LUTs are saved beside it. */
function PM_projectInfo() {
    return _pmWrap(function () {
        if (!app.project) return { name: null, path: null };
        return { name: app.project.name, path: app.project.path };
    }, "");
}

/**
 * Export the Program Monitor frame at the playhead as PNG.
 * QE's exportFramePNG returns immediately and writes asynchronously, and may
 * or may not append ".png" itself — the panel polls for both names.
 */
function PM_captureFrame(argJson) {
    return _pmWrap(function (a) {
        var seq = app.project.activeSequence;
        if (!seq) throw new Error("No active sequence. Open the sequence with your interview in the Timeline.");
        app.enableQE();
        var q = qe.project.getActiveSequence();
        var tc = q.CTI.timecode;
        q.exportFramePNG(tc, a.path);
        return {
            timecode: tc,
            sequence: seq.name,
            width: seq.frameSizeHorizontal,
            height: seq.frameSizeVertical,
            clip: _pmClipAtPlayhead(seq)
        };
    }, argJson);
}

function PM_selection() {
    return _pmWrap(function () {
        var seq = app.project.activeSequence;
        var sel = _pmSelectedVideo(seq);
        var out = [];
        for (var i = 0; i < sel.length; i++) {
            out.push({ name: sel[i].clip.name, track: sel[i].track + 1, hasLumetri: !!_pmLastLumetri(sel[i].clip) });
        }
        return out;
    }, "");
}

/** Add a fresh Lumetri Color to every selected video clip. */
function PM_addLumetri() {
    return _pmWrap(function () {
        var seq = app.project.activeSequence;
        if (!seq) throw new Error("No active sequence.");
        var sel = _pmSelectedVideo(seq);
        if (!sel.length) throw new Error("Select the target camera's clip(s) in the Timeline first.");
        app.enableQE();
        var fx = qe.project.getVideoEffectByName("Lumetri Color");
        if (!fx) throw new Error("Lumetri Color effect not found by name (non-English Premiere?).");
        var added = 0;
        var failed = [];
        for (var i = 0; i < sel.length; i++) {
            var it = _pmQeItem(sel[i].track, sel[i].index);
            if (!it) {
                failed.push(sel[i].clip.name);
                continue;
            }
            it.addVideoEffect(fx);
            added++;
        }
        return { added: added, failed: failed };
    }, "");
}

/** Describe a parameter value fully enough to compare a hand-set Lumetri with
 *  a script-set one: blob-type params read back as odd strings ("ﺾ"), so
 *  the first char codes are recorded as well as the text. */
function _pmDescribe(prop) {
    var v, type;
    try {
        v = prop.getValue();
        type = typeof v;
        v = String(v);
    } catch (e) {
        return { type: "error", value: String(e) };
    }
    var codes = [];
    for (var c = 0; c < v.length && c < 16; c++) codes.push(v.charCodeAt(c).toString(16));
    return { type: type, value: v, length: v.length, codes: codes.join(" ") };
}

/** SPIKE: every component and parameter on the first selected clip, with
 *  parameter indices (Lumetri has duplicate names, e.g. two "Input LUT"). */
function PM_dumpEffects() {
    return _pmWrap(function () {
        var seq = app.project.activeSequence;
        var sel = _pmSelectedVideo(seq);
        if (!sel.length) throw new Error("Select one video clip in the Timeline.");
        var clip = sel[0].clip;
        var comps = [];
        for (var i = 0; i < clip.components.numItems; i++) {
            var comp = clip.components[i];
            var props = [];
            for (var p = 0; p < comp.properties.numItems; p++) {
                var prop = comp.properties[p];
                var d = _pmDescribe(prop);
                d.index = p;
                d.name = prop.displayName;
                props.push(d);
            }
            comps.push({ index: i, name: comp.displayName, matchName: comp.matchName, props: props });
        }
        return { clip: clip.name, components: comps };
    }, "");
}

/**
 * SPIKE: set ONLY the named Lumetri parameters (on the last Lumetri of the
 * first selected clip) to a value, and read them back. Names match every
 * parameter with that display name; "#12" targets parameter index 12.
 * Undo (Ctrl+Z) reverts it.
 */
function PM_trySetLut(argJson) {
    return _pmWrap(function (a) {
        var seq = app.project.activeSequence;
        var sel = _pmSelectedVideo(seq);
        if (!sel.length) throw new Error("Select one video clip with Lumetri Color on it.");
        var lum = _pmLastLumetri(sel[0].clip);
        if (!lum) throw new Error("The selected clip has no Lumetri Color.");
        var targets = a.params || ["LUTAsset"];
        var tried = [];
        for (var p = 0; p < lum.properties.numItems; p++) {
            var prop = lum.properties[p];
            var name = String(prop.displayName);
            var hit = false;
            for (var t = 0; t < targets.length; t++) {
                if (targets[t] === name || targets[t] === "#" + p) hit = true;
            }
            if (!hit) continue;
            var rec = { index: p, name: name, before: _pmDescribe(prop), after: null, error: null };
            try { prop.setValue(a.value, true); } catch (e4) { rec.error = String(e4); }
            rec.after = _pmDescribe(prop);
            tried.push(rec);
        }
        return { clip: sel[0].clip.name, tried: tried };
    }, argJson);
}
