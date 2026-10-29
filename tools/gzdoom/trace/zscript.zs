// Per-tic trace for comparing GZDoom's behaviour with OpenDLE's.
//
// Loaded with `-file tools/gzdoom/trace`, this prints one `ODT` line per tic with the
// state of the player (and optionally one watched actor), then `ODT END` when the
// scenario's tic budget runs out. `run.mjs` reads those lines off stdout, so no log file
// flag and no console interaction is involved.
//
// The handler is registered from MAPINFO (`gameinfo`), so a scenario is only an IWAD, a
// map, a spawn point and an action: nothing is added to the map itself.
version "4.14"

class OpenDLETrace : StaticEventHandler
{
	int maxTics;
	string scripted;   // `action` is a ZScript keyword
	string watchClass;
	int watchTid;

	override void OnRegister()
	{
		// CVar.GetCVar returns a handle; a missing cvar is the default the CVARINFO declared.
		CVar tics = CVar.GetCVar('odt_tics');
		maxTics = tics ? tics.GetInt() : 140;
		CVar act = CVar.GetCVar('odt_action');
		scripted = act ? act.GetString() : "";
		CVar watch = CVar.GetCVar('odt_watch');
		watchClass = watch ? watch.GetString() : "";
		CVar tid = CVar.GetCVar('odt_tid');
		watchTid = tid ? tid.GetInt() : 0;
	}

	override void WorldLoaded(WorldEvent e)
	{
		// A single line with everything the scenario asked for, so a trace file is
		// self-describing.
		Console.Printf("ODT START map=%s tics=%d action=%s watch=%s tid=%d\n",
			Level.MapName, maxTics, scripted, watchClass, watchTid);
		// Aiming is set once, at load. Writing the player's angle every tic hung the engine
		// after a few seconds, and writing velocity wedges it against a wall: a trace may
		// observe the player, but it must not animate it.
		if (scripted == "aim" && players[0].mo != null) players[0].mo.angle = GetCvarAngle();
	}

	override void WorldTick()
	{
		int tic = Level.time;
		// One tic past the budget only prints the end marker; a trace that kept running
		// would keep adding samples the other engine never produces.
		if (tic > maxTics)
		{
			return;
		}

		Actor mo = players[0].mo;
		if (mo != null)
		{
			PrintActor("player", mo);
		}

		Actor watched = Watched();
		if (watched != null) PrintActor("watch", watched);

		if (tic >= maxTics) Console.Printf("ODT END tics=%d\n", maxTics);
	}

	void PrintActor(string tag, Actor a)
	{
		// `tics` is what is left of the current state, so a state that runs for the wrong
		// number of tics shows up here even when nothing moved.
		Console.Printf("ODT %d %s cls=%s x=%.3f y=%.3f z=%.3f vx=%.3f vy=%.3f vz=%.3f angle=%.3f pitch=%.3f health=%d tics=%d\n",
			Level.time, tag, a.GetClassName(), a.pos.x, a.pos.y, a.pos.z,
			a.vel.x, a.vel.y, a.vel.z, a.angle, a.pitch, a.health, a.tics);
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
			return a;
		}
		return null;
	}
}
