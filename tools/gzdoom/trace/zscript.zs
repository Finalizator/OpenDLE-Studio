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

class OpenDLETrace : StaticEventHandler
{
	int maxTics;
	string scripted;
	string watchClass;
	int watchTid;

	override void OnRegister()
	{
		CVar tics = CVar.GetCVar('odt_tics');
		maxTics = tics ? tics.GetInt() : 140;
		CVar act = CVar.GetCVar('odt_action');
		scripted = act ? act.GetString() : "";
		CVar face = CVar.GetCVar('odt_face');
		faceWatched = face ? face.GetInt() != 0 : false;
		CVar watch = CVar.GetCVar('odt_watch');
		watchClass = watch ? watch.GetString() : "";
		CVar tid = CVar.GetCVar('odt_tid');
		watchTid = tid ? tid.GetInt() : 0;
	}

	override void WorldLoaded(WorldEvent e)
	{
		Console.Printf("ODT START map=%s tics=%d action=%s watch=%s tid=%d\n",
			Level.MapName, maxTics, scripted, watchClass, watchTid);

		// Aiming is set once, at load. Writing the player's angle every tic hung the engine
		// after a few seconds, and writing velocity wedges it against a wall: a trace may
		// observe the player, but it must not animate it.
		if (scripted == "aim" && players[0].mo != null) players[0].mo.angle = GetCvarAngle();

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

	override void WorldTick()
	{
		int tic = Level.time;
		// One tic past the budget only prints the end marker; a trace that kept running
		// would keep adding samples the other engine never produces.
		if (tic > maxTics) return;

		Actor mo = players[0].mo;
		if (mo != null) PrintActor("player", mo);

		Actor watched = Watched();
		if (watched != null)
		{
			if (!statesDumped) { statesDumped = true; DumpStates(watched); }
			// `summon` faces the crosshair, so a summoned monster starts with its back to
			// the player and A_Look never fires. Facing it once, at spawn, is the same kind
			// of one-off setup as the player's aim — not animation, which the trace must
			// never do (a per-tic write hung the engine).
			if (faceWatched && !faced) { faced = true; FacePlayer(watched); }
			PrintActor("watch", watched);
		}

		if (tic >= maxTics) Console.Printf("ODT END tics=%d\n", maxTics);
	}

	void PrintActor(string tag, Actor a)
	{
		// `tics` is what is left of the current state, `spr`/`frame` name the picture: a
		// state that runs for the wrong number of tics, or the wrong picture on the wrong
		// tic, shows up here even when nothing moved.
		Console.Printf("ODT %d %s cls=%s x=%.3f y=%.3f z=%.3f vx=%.3f vy=%.3f vz=%.3f angle=%.3f pitch=%.3f health=%d tics=%d spr=%d frame=%d\n",
			Level.time, tag, a.GetClassName(), a.pos.x, a.pos.y, a.pos.z,
			a.vel.x, a.vel.y, a.vel.z, a.angle, a.pitch, a.health, a.tics,
			a.curstate.sprite, a.curstate.Frame);
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

	/** Points an actor at the player, once. */
	void FacePlayer(Actor a)
	{
		Actor player = players[0].mo;
		if (a == null || player == null) return;
		a.angle = atan2(player.pos.y - a.pos.y, player.pos.x - a.pos.x);
	}

	/** `odt_angle`: the heading an `aim` scenario points the player at, in degrees. */
	double GetCvarAngle()
	{
		CVar angle = CVar.GetCVar('odt_angle');
		return angle ? angle.GetFloat() : 90.0;
	}

	/** A state table is a property of the class, so it is dumped once per run. */
	bool statesDumped;
	/** `odt_face`: turn the watched actor towards the player once, so it can see them. */
	bool faceWatched;
	bool faced;

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
