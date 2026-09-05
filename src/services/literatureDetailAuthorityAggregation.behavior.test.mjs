import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const directory = path.dirname(fileURLToPath(import.meta.url));
const bundle = await build({
  stdin: {
    contents: `
      export { createLiteratureDetailAuthorityAggregationCoordinator }
        from "./literatureSelectorService.ts";
      export { createPlanningOwnerAuthorityPort }
        from "./planningOwnerAuthorityPort.ts";
      export { MANUSCRIPT_PROVISIONING_OWNER_CHANNEL_CONTRACTS }
        from "./manuscriptProvisioningContract.ts";
    `,
    resolveDir: directory,
    sourcefile: "literature-detail-authority-aggregation-harness.ts"
  },
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  target: "es2022"
});
const contract = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
);

const literatureDescriptors = contract.MANUSCRIPT_PROVISIONING_OWNER_CHANNEL_CONTRACTS
  .filter((descriptor) => descriptor.ownerType === "literature")
  .sort((left, right) => left.manuscriptChannel.localeCompare(right.manuscriptChannel));

assert.deepEqual(
  literatureDescriptors.map((descriptor) => descriptor.manuscriptChannel),
  ["dedicated_notes", "literature_outline"]
);

function authorityFixture(ownerIds) {
  const active = new Map();
  const events = [];
  let tokenSequence = 0;
  const projects = [{
    id: "project-1",
    title: "Project",
    status: "active",
    updatedAt: "project-v1"
  }];
  const owners = new Map(ownerIds.map((ownerId) => [
    `literature:${ownerId}`,
    {
      id: ownerId,
      primaryProjectId: "project-1",
      title: ownerId,
      updatedAt: `${ownerId}-v1`
    }
  ]));
  const leaseClient = {
    async tryAcquireMany(requestId, requests) {
      const requestedKeys = new Set(requests.map((request) => JSON.stringify(request.key)));
      for (const grant of active.values()) {
        if (grant.requests.some((request) => requestedKeys.has(JSON.stringify(request.key)))) {
          events.push(`conflict:${requestId}`);
          throw new Error("AUTHORITY_LEASE_CONFLICT");
        }
      }
      const token = `lease-${++tokenSequence}`;
      const grant = {
        token,
        requestId,
        holderKind: "callerBound",
        registryGeneration: "generation-1",
        requests
      };
      active.set(token, grant);
      events.push(`acquire:${requestId}`);
      return grant;
    },
    async validate(token, requests) {
      const grant = active.get(token);
      assert.ok(grant);
      assert.deepEqual(grant.requests, requests);
      return { valid: true, registryGeneration: "generation-1" };
    },
    async release(token) {
      const grant = active.get(token);
      active.delete(token);
      events.push(`release:${grant?.requestId ?? token}`);
      return { released: Boolean(grant) };
    }
  };
  const port = contract.createPlanningOwnerAuthorityPort({
    leaseClient,
    readPlanningEnvelope: async () => ({
      repositoryEpoch: "11111111-1111-4111-8111-111111111111",
      revision: "1",
      snapshot: {
        projects,
        reviews: [],
        routeNodes: [],
        routeCheckpoints: [],
        taskCheckpoints: [],
        researchRoutines: [],
        routineCheckIns: [],
        tasks: [],
        entityLinks: []
      }
    }),
    readNonPlanningOwner: async (ownerType, ownerId) => owners.get(`${ownerType}:${ownerId}`),
    monotonicNow: () => 42
  });
  return { active, events, port };
}

async function runLiteratureReadinessAuthority(fixture, ownerId, aggregateId, onLease) {
  for (const descriptor of literatureDescriptors) {
    const requestId = `${aggregateId}-${ownerId}-${descriptor.manuscriptChannel}`;
    const result = await fixture.port.acquirePlanningOwnerAuthority({
      intent: "provisioningRead",
      requestId,
      ownerType: descriptor.ownerType,
      ownerId,
      scope: descriptor.manuscriptChannel
    });
    if (result.status !== "Validated") {
      throw new Error(result.code);
    }
    try {
      await onLease?.(descriptor.manuscriptChannel);
    } finally {
      await fixture.port.releasePlanningOwnerAuthority(result.handle);
    }
  }
  return aggregateId;
}

test("fresh-create outer aggregate serializes same-owner Planning authority without conflict", async () => {
  const coordinator = contract.createLiteratureDetailAuthorityAggregationCoordinator();
  const fixture = authorityFixture(["literature-fresh"]);
  let activeAggregates = 0;
  let maxActiveAggregates = 0;
  const run = (aggregateId) => coordinator.run("literature-fresh", async () => {
    activeAggregates += 1;
    maxActiveAggregates = Math.max(maxActiveAggregates, activeAggregates);
    try {
      return await runLiteratureReadinessAuthority(
        fixture,
        "literature-fresh",
        aggregateId
      );
    } finally {
      activeAggregates -= 1;
    }
  });

  assert.deepEqual(await Promise.all([run("refresh-event"), run("page-refresh")]), [
    "refresh-event",
    "page-refresh"
  ]);
  assert.equal(maxActiveAggregates, 1);
  assert.equal(fixture.events.some((event) => event.startsWith("conflict:")), false);
  assert.equal(fixture.active.size, 0);
});

test("restart-equivalent new aggregate instance retains same-owner non-overlap and drains leases", async () => {
  const coordinator = contract.createLiteratureDetailAuthorityAggregationCoordinator();
  const fixture = authorityFixture(["literature-restart"]);
  const order = [];
  const run = (aggregateId) => coordinator.run("literature-restart", async () => {
    order.push(`start:${aggregateId}`);
    const result = await runLiteratureReadinessAuthority(
      fixture,
      "literature-restart",
      aggregateId
    );
    order.push(`end:${aggregateId}`);
    return result;
  });

  await Promise.all([run("strict-mount-a"), run("strict-mount-b")]);
  assert.deepEqual(order, [
    "start:strict-mount-a",
    "end:strict-mount-a",
    "start:strict-mount-b",
    "end:strict-mount-b"
  ]);
  assert.equal(fixture.active.size, 0);
  assert.equal(fixture.events.filter((event) => event.startsWith("conflict:")).length, 0);
});

test("different Literature owners remain concurrently runnable", async () => {
  const coordinator = contract.createLiteratureDetailAuthorityAggregationCoordinator();
  let active = 0;
  let maxActive = 0;
  let releaseBoth;
  const bothEntered = new Promise((resolve) => {
    releaseBoth = resolve;
  });
  const run = (ownerId) => coordinator.run(ownerId, async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    if (active === 2) releaseBoth();
    await bothEntered;
    active -= 1;
    return ownerId;
  });

  assert.deepEqual(await Promise.all([run("literature-a"), run("literature-b")]), [
    "literature-a",
    "literature-b"
  ]);
  assert.equal(maxActive, 2);
});

test("failed aggregate is not swallowed and does not leave a stale owner turn", async () => {
  const coordinator = contract.createLiteratureDetailAuthorityAggregationCoordinator();
  await assert.rejects(
    coordinator.run("literature-failure", async () => {
      throw new Error("AGGREGATE_FAILURE");
    }),
    /AGGREGATE_FAILURE/u
  );
  assert.equal(
    await coordinator.run("literature-failure", async () => "next-entered"),
    "next-entered"
  );
});
