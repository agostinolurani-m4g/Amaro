import team from '../../data/team.json';

export default function TeamPage() {
  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-bold">Team</h1>
      <div className="grid sm:grid-cols-2 md:grid-cols-3 gap-6">
        {team.map(m => (
          <div key={m.name} className="border rounded-xl p-4 text-center">
            <div className="h-32 bg-gray-100 rounded overflow-hidden flex items-center justify-center">
              {m.photoUrl ? <img src={m.photoUrl} alt={m.name} className="h-full" /> : <span>Foto</span>}
            </div>
            <div className="mt-3 font-semibold">{m.name}</div>
            <div className="text-sm text-gray-600">{m.roleTitle}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
