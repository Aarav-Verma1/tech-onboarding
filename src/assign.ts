import { ObjectId } from "mongodb";
import { collections, type Assignment } from "./db.js";

export type AssignResult =
  | { kind: "assigned"; assignment: Assignment }
  | { kind: "judge-busy" }
  | { kind: "none-available" };

export function pickProject(
  projectIds: string[],
  seenByJudge: Set<string>,
  queuedProjects: Set<string>,
  completedCounts: Map<string, number>
): string | undefined {
  const available = projectIds.filter((id) => !seenByJudge.has(id) && !queuedProjects.has(id));
  if (available.length === 0) return undefined;

  const count = (id: string) => completedCounts.get(id) ?? 0;
  const fewest = Math.min(...available.map(count));
  const ties = available.filter((id) => count(id) === fewest);

  return ties[Math.floor(Math.random() * ties.length)];
}

export async function assignNext(judgeId: string): Promise<AssignResult> {
  const { projects, assignments } = collections();

  for (let attempt = 0; attempt < 50; attempt++) {
    if (await assignments.findOne({ judgeId, status: "QUEUED" })) {
      return { kind: "judge-busy" };
    }

    const [projectDocs, mine, queued, completed] = await Promise.all([
      projects.find({}, { projection: { _id: 1 } }).toArray(),
      assignments.find({ judgeId }, { projection: { projectId: 1 } }).toArray(),
      assignments.find({ status: "QUEUED" }, { projection: { projectId: 1 } }).toArray(),
      assignments
        .aggregate<{ _id: string; n: number }>([
          { $match: { status: "COMPLETED" } },
          { $group: { _id: "$projectId", n: { $sum: 1 } } },
        ])
        .toArray(),
    ]);

    const projectId = pickProject(
      projectDocs.map((p) => p._id),
      new Set(mine.map((a) => a.projectId)),
      new Set(queued.map((a) => a.projectId)),
      new Map(completed.map((c) => [c._id, c.n]))
    );
    if (projectId === undefined) return { kind: "none-available" };

    const assignment: Assignment = {
      _id: new ObjectId(),
      judgeId,
      projectId,
      status: "QUEUED",
      createdAt: new Date(),
    };

    try {
      await assignments.insertOne(assignment);
      return { kind: "assigned", assignment };
    } catch (err: any) {
      if (err?.code !== 11000) throw err;
      if (err.keyPattern?.judgeId) return { kind: "judge-busy" };
    }
  }

  throw new Error(`could not assign a project to judge ${judgeId}`);
}
