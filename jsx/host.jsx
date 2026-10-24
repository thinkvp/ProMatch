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
        // QE returns an empty dummy (name "") for an unknown name, not null.
        if (!fx || !fx.name) throw new Error("Lumetri Color effect not found by name (non-English Premiere?).");
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

/* -------------------------------------------------- native ProMatch effect */

var PM_EFFECT_NAME = "ProMatch";
/** Contained in the component matchName (Premiere prefixes AE effects with "AE."). */
var PM_EFFECT_MATCH = "PRMT ProMatch";

function _pmFindEffect(clip) {
    for (var i = 0; i < clip.components.numItems; i++) {
        var comp = clip.components[i];
        if (String(comp.matchName).indexOf(PM_EFFECT_MATCH) !== -1) return { comp: comp, index: i };
    }
    return null;
}

function _pmParam(comp, name) {
    for (var p = 0; p < comp.properties.numItems; p++) {
        if (String(comp.properties[p].displayName) === name) return comp.properties[p];
    }
    return null;
}

/** Every video clip in the sequence carrying a ProMatch effect with Match ID `id`. */
function _pmClipsWithMatch(seq, id) {
    var out = [];
    for (var t = 0; t < seq.videoTracks.numTracks; t++) {
        var track = seq.videoTracks[t];
        for (var c = 0; c < track.clips.numItems; c++) {
            var clip = track.clips[c];
            var fx = _pmFindEffect(clip);
            if (!fx) continue;
            var mid = _pmParam(fx.comp, "Match ID");
            if (mid && Math.round(Number(mid.getValue())) === id) out.push({ clip: clip, track: t, index: c });
        }
    }
    return out;
}

/** Is there a Lumetri Color before (so applied before) the ProMatch effect? */
function _pmLumetriBefore(clip, fxIndex) {
    for (var i = 0; i < fxIndex; i++) {
        if (String(clip.components[i].matchName).indexOf("Lumetri") !== -1) return true;
    }
    return false;
}

/**
 * One-click apply. The panel has already written %APPDATA%\ProMatch\luts\<id>.cube.
 * Selected video clips get a ProMatch effect (added if missing, reused if
 * present) set to Match ID `id`. Every clip in the sequence already using
 * `id` is updated too. All of them get one new Revision, which is what makes
 * Premiere drop its cached frames and re-render.
 */
function PM_applyMatch(argJson) {
    return _pmWrap(function (a) {
        var id = Math.round(Number(a.id));
        if (!(id > 0)) throw new Error("Bad match id.");
        var seq = app.project.activeSequence;
        if (!seq) throw new Error("No active sequence.");
        var sel = _pmSelectedVideo(seq);
        var existing = _pmClipsWithMatch(seq, id);
        if (!sel.length && !existing.length) {
            throw new Error("Select the target camera's clip(s) in the Timeline first.");
        }

        // Add the effect where it is missing.
        var added = [];
        var failed = [];
        var qeFx = null;
        for (var i = 0; i < sel.length; i++) {
            if (_pmFindEffect(sel[i].clip)) continue;
            if (!qeFx) {
                app.enableQE();
                qeFx = qe.project.getVideoEffectByName(PM_EFFECT_NAME);
                if (!qeFx || !qeFx.name) return { missingEffect: true, clips: [] };
            }
            var it = _pmQeItem(sel[i].track, sel[i].index);
            if (!it) {
                failed.push(sel[i].clip.name);
                continue;
            }
            if (it.addVideoEffect(qeFx) === false) {
                failed.push(sel[i].clip.name);
                continue;
            }
            added.push(sel[i].track + ":" + sel[i].index);
        }

        // Targets: selection + clips already on this id, without duplicates.
        var targets = [];
        var all = sel.concat(existing);
        for (var k = 0; k < all.length; k++) {
            var dup = false;
            for (var m = 0; m < targets.length; m++) {
                if (targets[m].track === all[k].track && targets[m].index === all[k].index) dup = true;
            }
            if (!dup && _pmFindEffect(all[k].clip)) targets.push(all[k]);
        }

        // Build 1 of the effect re-rendered via a Revision slider: one new
        // value for all of them, above any they have now. Build 2+ embeds the
        // LUT instead, and setting it re-renders by itself.
        var rev = null;
        for (var r = 0; r < targets.length; r++) {
            var rp = _pmParam(_pmFindEffect(targets[r].clip).comp, "Revision");
            if (rp) rev = Math.max(rev === null ? 0 : rev, Math.round(Number(rp.getValue())));
        }
        if (rev !== null) rev = (rev + 1) % 9999999;

        var clips = [];
        for (var q = 0; q < targets.length; q++) {
            var clip = targets[q].clip;
            var fx = _pmFindEffect(clip);
            var midP = _pmParam(fx.comp, "Match ID");
            var revP = _pmParam(fx.comp, "Revision");
            var lutP = _pmParam(fx.comp, "LUT");
            var before = Math.round(Number(midP.getValue()));
            var embedded = false;
            var lutNote = lutP ? null : "no LUT parameter";
            if (lutP && a.lut) {
                try {
                    lutP.setValue(a.lut, true);
                    // Premiere stores the string as-is (UTF-16) without calling the
                    // effect's scan callback; the effect decodes it when rendering.
                    // Read it back to confirm the whole text was stored.
                    var back = String(lutP.getValue());
                    embedded = back === a.lut;
                    if (!embedded) lutNote = "read back " + back.length + " chars: " + back.substring(0, 24);
                } catch (e5) {
                    lutNote = String(e5);
                }
            }
            midP.setValue(id, true);
            if (revP) revP.setValue(rev, true);
            var wasAdded = false;
            for (var x = 0; x < added.length; x++) if (added[x] === targets[q].track + ":" + targets[q].index) wasAdded = true;
            clips.push({
                name: clip.name,
                track: targets[q].track + 1,
                added: wasAdded,
                previousId: before,
                embedded: embedded,
                lutNote: lutNote,
                lumetriBefore: _pmLumetriBefore(clip, fx.index)
            });
        }
        return { missingEffect: false, revision: rev, clips: clips, failed: failed };
    }, argJson);
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
