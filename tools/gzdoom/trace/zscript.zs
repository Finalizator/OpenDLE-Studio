// Per-tic trace for comparing GZDoom's behaviour with OpenDLE's.
//
// Loaded with `-file tools/gzdoom/trace`, this prints `ODT` lines that `run.mjs` reads from
// GZDoom's own log:
//
//   ODT START …                 the scenario, so a trace is self-describing
//   ODT STATES …                once per actor class: the real state table (animation)
//   ODT LABEL …                 where each label sits in that table (See, Missile, …)
//   ODT <tic> player …          the player every tic
//   ODT <tic> watch …           the watched actor every tic, including its animation
//   ODT EVENT <tic> …           damage and death, which positions alone cannot show
//   ODT END …                   the scenario is complete
//
// The handler is registered from MAPINFO (`gameinfo`), so a scenario is an IWAD, a map, a
// spawn point and a budget: nothing is added to the map.
version "4.14"

// `side_t::ETexpart` is top=0, mid=1, bottom=2 (src/gamedata/r_defs.h); the enum is not
// exposed to ZScript, so the slot is named here.
const SIDE_MID = 1;

class OpenDLETrace : StaticEventHandler
{
	int maxTics;
	string scripted;
	string watchClass;
	int watchTid;
	int scrollLines;
	Array<double> scrollBase;

	override void OnRegister()
	{
		CVar tics = CVar.GetCVar('odt_tics');
		maxTics = tics ? tics.GetInt() : 140;
		CVar act = CVar.GetCVar('odt_action');
		scripted = act ? act.GetString() : "";
		CVar watch = CVar.GetCVar('odt_watch');
		watchClass = watch ? watch.GetString() : "";
		CVar tid = CVar.GetCVar('odt_tid');
		watchTid = tid ? tid.GetInt() : 0;
		CVar scroll = CVar.GetCVar('odt_scroll');
		scrollLines = scroll ? scroll.GetInt() : 0;
	}

	override void WorldLoaded(WorldEvent e)
	{
		Console.Printf("ODT START map=%s tics=%d action=%s watch=%s tid=%d\n",
			Level.MapName, maxTics, scripted, watchClass, watchTid);

		// Aiming is set once, at load. Writing the player's angle every tic hung the engine
		// after a few seconds, and writing velocity wedges it against a wall: a trace may
		// observe the player, but it must not animate it.
		if (scripted == "aim" && players[0].mo != null) players[0].mo.angle = GetCvarAngle();
		CVar faced = CVar.GetCVar('odt_face');
		if (faced && faced.GetInt() != 0 && players[0].mo != null) SpawnWatched();

		// The watched actor may not exist yet when the level loads (a `summon` runs after
		// this), so the state table is dumped from the first instance seen while ticking.
		if (watchClass != "")
		{
			Actor present = Watched();
			if (present != null) { statesDumped = true; DumpStates(present); }
		}
	}

	/**
	 * Prints the actor class's animation, label by label.
	 *
	 * A state table is not one chain: each label's block ends by jumping back (Spawn/Loop) or
	 * to another label (Goto See), so walking `NextState` from Spawn yields the Spawn block
	 * and nothing else. Walking from each label in turn therefore yields exactly what an
	 * animation clip is — the frames of that clip, in order, with their durations.
	 *
	 * `State.Frame` is the letter of the frame (65 = 'A') and `Tics` its duration. Sprite
	 * names are not exposed to ZScript, so a sprite is identified by its index: enough to
	 * tell whether two states share a sprite, which is what a sprite change means.
	 */
	void DumpStates(Actor probe)
	{
		if (probe == null) return;
		string className = probe.GetClassName();
		string labels[] = {"Spawn", "Idle", "See", "Melee", "Missile", "Pain", "Death", "XDeath", "Raise", "Crash"};
		// Every label's first state, so a walk stops when the chain jumps into another
		// block. Missile/Pain/Raise end with `Goto See`, and without this the walk ran on
		// through the rest of the actor's table under the wrong label.
		State starts[10];
		for (int at = 0; at < labels.Size(); at++) starts[at] = probe.FindStateByString(labels[at], false);
		for (int at = 0; at < labels.Size(); at++)
		{
			State label = starts[at];
			if (label == null) continue;
			// A label can share its first state with another (Melee falling through to
			// Missile), which is reported as-is: that is the behaviour being measured.
			State current = label;
			int index = 0;
			while (index < 128)
			{
				Console.Printf("ODT STATE %s label=%s i=%d spr=%d frame=%d tics=%d\n",
					className, labels[at], index, current.sprite, current.Frame, current.Tics);
				// Continue only while the chain advances by exactly one state from this
				// label's start. `Loop` and `Goto` are jumps, so the distance stops being
				// index+1 exactly where the block ends — one rule for every label. Testing
				// "did we come back to the start?" did not: the Arachnotron's See loop jumps
				// backwards inside its own block and the walk ran to the cap, reporting 128
				// frames where Doom plays 8.
				State next = current.NextState;
				if (next == null) break;
				if (label.DistanceTo(next) != index + 1) break;
				current = next;
				index++;
			}
			Console.Printf("ODT LABEL %s name=%s index=%d frames=%d\n",
				className, labels[at], probe.FindStateByString("Spawn", false).DistanceTo(label), index + 1);
		}
	}

	/**
	 * Places the scenario's actor in front of the player, facing them.
	 *
	 * A class has to be written as a literal here, so the table covers the monsters the
	 * comparison covers. `summon` was tried first and rejected: it places the actor at the
	 * crosshair, which depends on map geometry, and the resulting position was not
	 * reproducible — the actor landed on the player, or on top of a map monster.
	 */
	void SpawnWatched()
	{
		CVar nameCvar = CVar.GetCVar('odt_spawn');
		string name = nameCvar ? nameCvar.GetString() : "";
		CVar distanceCvar = CVar.GetCVar('odt_spawn_distance');
		double distance = distanceCvar ? distanceCvar.GetFloat() : 96.0;
		Actor player = players[0].mo;
		if (player == null || name == "") return;
		// A vector is built from a bare parenthesised triple in ZScript, not by calling a
		// constructor, so the position is assembled field by field instead.
		vector3 placement = player.pos;
		placement.x += cos(player.angle) * distance;
		placement.y += sin(player.angle) * distance;
		placement.z += 8;

		if (name == "ZombieMan") spawned = Actor.Spawn("ZombieMan", placement);
		else if (name == "ShotgunGuy") spawned = Actor.Spawn("ShotgunGuy", placement);
		else if (name == "ChaingunGuy") spawned = Actor.Spawn("ChaingunGuy", placement);
		else if (name == "DoomImp") spawned = Actor.Spawn("DoomImp", placement);
		else if (name == "Demon") spawned = Actor.Spawn("Demon", placement);
		else if (name == "Spectre") spawned = Actor.Spawn("Spectre", placement);
		else if (name == "Cacodemon") spawned = Actor.Spawn("Cacodemon", placement);
		else if (name == "LostSoul") spawned = Actor.Spawn("LostSoul", placement);
		else if (name == "HellKnight") spawned = Actor.Spawn("HellKnight", placement);
		else if (name == "BaronOfHell") spawned = Actor.Spawn("BaronOfHell", placement);
		else if (name == "Arachnotron") spawned = Actor.Spawn("Arachnotron", placement);
		else if (name == "Revenant") spawned = Actor.Spawn("Revenant", placement);
		else if (name == "Fatso") spawned = Actor.Spawn("Fatso", placement);
		else if (name == "Archvile") spawned = Actor.Spawn("Archvile", placement);
		else if (name == "SpiderMastermind") spawned = Actor.Spawn("SpiderMastermind", placement);
		else if (name == "Cyberdemon") spawned = Actor.Spawn("Cyberdemon", placement);
		else if (name == "PainElemental") spawned = Actor.Spawn("PainElemental", placement);
		else if (name == "CommanderKeen") spawned = Actor.Spawn("CommanderKeen", placement);
		else Console.Printf("ODT ERROR spawn: %s is not in the tracer's class table\n", name);

		if (spawned == null) { Console.Printf("ODT ERROR spawn: %s could not be placed\n", name); return; }
		// Facing the player once, at spawn: a summoned monster starts with its back turned
		// and A_Look never fires. This is one-off setup, like the player's aim.
		spawned.angle = atan2(player.pos.y - spawned.pos.y, player.pos.x - spawned.pos.x);
	}

	override void WorldTick()
	{
		int tic = Level.time;
		// One tic past the budget only prints the end marker; a trace that kept running
		// would keep adding samples the other engine never produces.
		if (tic > maxTics) return;

		Actor mo = players[0].mo;
		if (mo != null) PrintActor("player", mo);
		// The eye a title map films from is not the player: a `ChangeCamera` moves the view
		// to another actor, and where that view *is* decides every screen position in the
		// scene. `viewz` is the number the renderer actually uses.
		String campos = "none";
		double camz = 0.0;
		if (players[0].camera != null)
		{
			campos = "" .. players[0].camera.GetClassName();
			camz = players[0].camera.pos.z;
		}
		Console.Printf("ODT VIEW %d viewz=%.3f viewheight=%.3f camz=%.3f campos=%s\n",
			tic, players[0].viewz, players[0].viewheight, camz, campos);

		// A surface that moves because a scroller moved it shows up here and nowhere else: the
		// geometry stays put, the sector heights stay put, and only the sidedef's texture
		// offsets change. Logged as a delta from the first sample so a static map prints
		// nothing at all.
		if (scrollLines > 0 && Level.Lines.Size() > 0)
		{
			if (scrollBase.Size() == 0)
			{
				for (int i = 0; i < scrollLines && i < Level.Lines.Size(); i++)
				{
					Line l = Level.Lines[i];
					if (l == null || l.sidedef[0] == null) { scrollBase.Push(0.0); scrollBase.Push(0.0); continue; }
					scrollBase.Push(l.sidedef[0].GetTextureXOffset(SIDE_MID));
					scrollBase.Push(l.sidedef[0].GetTextureYOffset(SIDE_MID));
				}
			}
			for (int i = 0; i < scrollLines && i < Level.Lines.Size(); i++)
			{
				Line l = Level.Lines[i];
				if (l == null || l.sidedef[0] == null) continue;
				double dx = l.sidedef[0].GetTextureXOffset(SIDE_MID) - scrollBase[i * 2];
				double dy = l.sidedef[0].GetTextureYOffset(SIDE_MID) - scrollBase[i * 2 + 1];
				if (dx != 0.0 || dy != 0.0)
					Console.Printf("ODT SCROLL %d line=%d dx=%.4f dy=%.4f\n", tic, i, dx, dy);
			}
		}

		// The spawned actor is watched by identity, so a map monster of the same class can
		// never be mistaken for it.
		Actor watched = spawned != null ? spawned : Watched();
		if (watched != null)
		{
			if (!statesDumped) { statesDumped = true; DumpStates(watched); }
			PrintActor("watch", watched);
		}

		if (tic >= maxTics) Console.Printf("ODT END tics=%d\n", maxTics);
	}

	void PrintActor(string tag, Actor a)
	{
		// `tics` is what is left of the current state, `spr`/`frame` name the picture: a
		// state that runs for the wrong number of tics, or the wrong picture on the wrong
		// tic, shows up here even when nothing moved.
		// The weapon's bob is added at draw time rather than stored in the psprite, so the
		// trace reports the number it is built from: `bob` is the squared bob velocity,
		// capped at 16. (`BobTimer` is a native field with no script name, so the swing's
		// phase is not visible here; it advances one per player tic.)
		Console.Printf("ODT %d %s cls=%s x=%.3f y=%.3f z=%.3f vx=%.3f vy=%.3f vz=%.3f angle=%.3f pitch=%.3f health=%d tics=%d spr=%d frame=%d bob=%.3f\n",
			Level.time, tag, a.GetClassName(), a.pos.x, a.pos.y, a.pos.z,
			a.vel.x, a.vel.y, a.vel.z, a.angle, a.pitch, a.health, a.tics,
			a.curstate.sprite, a.curstate.Frame,
			a.player ? a.player.bob : 0);
	}

	// Damage and death are the behaviour that matters most and the hardest to read out of
	// positions alone, so they are recorded as events rather than inferred.
	override void WorldThingDamaged(WorldEvent e)
	{
		if (e.Thing == null) return;
		Console.Printf("ODT EVENT %d damaged=%s damage=%d health=%d type=%s\n",
			Level.time, e.Thing.GetClassName(), e.Damage, e.Thing.health, e.DamageType);
	}

	override void WorldThingDied(WorldEvent e)
	{
		if (e.Thing == null) return;
		string inflictor = "none";
		if (e.Inflictor != null) inflictor = e.Inflictor.GetClassName();
		Console.Printf("ODT EVENT %d died=%s inflictor=%s\n",
			Level.time, e.Thing.GetClassName(), inflictor);
	}

	/** `odt_angle`: the heading an `aim` scenario points the player at, in degrees. */
	double GetCvarAngle()
	{
		CVar angle = CVar.GetCVar('odt_angle');
		return angle ? angle.GetFloat() : 90.0;
	}

	/** A state table is a property of the class, so it is dumped once per run. */
	bool statesDumped;
	/** The actor this run placed, so its first tic can be described on tic zero. */
	Actor spawned;

	/** The actor a scenario watches: the first one of that class with that tid. */
	Actor Watched()
	{
		if (watchClass == "") return null;
		ThinkerIterator it = ThinkerIterator.Create("Actor");
		Actor a;
		while ((a = Actor(it.Next())) != null)
		{
			if (a.GetClassName() != watchClass) continue;
			if (watchTid > 0 && a.tid != watchTid) continue;
			if (a.health <= 0) continue;
			return a;
		}
		return null;
	}
}
