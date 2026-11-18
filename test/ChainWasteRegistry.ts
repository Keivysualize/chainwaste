import { expect } from "chai";
import { network } from "hardhat";

const { ethers, networkHelpers } = await network.create();
const wasteCode = ethers.encodeBytes32String("B3-DEMO");
const documentHash = ethers.id("manifest document");
const sealHash = ethers.id("seal");
const proofHash = ethers.id("treatment proof");

async function deployRegistry() {
  const [regulator, generator, transporter, processor, auditor, oracle, otherTransporter, outsider] =
    await ethers.getSigners();
  const registry = await ethers.deployContract("ChainWasteRegistry", [regulator.address]);
  const generatorRole = await registry.GENERATOR_ROLE();
  const transporterRole = await registry.TRANSPORTER_ROLE();
  await registry.registerActor(generator.address, generatorRole);
  await registry.registerActor(transporter.address, transporterRole);
  await registry.registerActor(otherTransporter.address, transporterRole);
  await registry.registerActor(processor.address, await registry.PROCESSOR_ROLE());
  await registry.registerActor(auditor.address, await registry.AUDITOR_ROLE());
  await registry.registerActor(oracle.address, await registry.IOT_ORACLE_ROLE());

  async function create() {
    return registry.connect(generator).createManifest(
      transporter.address, processor.address, wasteCode, 10_000, documentHash,
    );
  }

  async function prepareReceipt(receivedKg: number) {
    await create();
    await registry.connect(oracle).recordPickupWeight(1, 10_000, sealHash);
    await registry.connect(transporter).confirmPickup(1);
    await registry.connect(oracle).recordReceivedWeight(1, receivedKg);
  }

  return { registry, regulator, generator, transporter, processor, auditor, oracle, otherTransporter, outsider, generatorRole, create, prepareReceipt };
}

describe("ChainWasteRegistry", function () {
  it("records the manifest lifecycle and the treatment proof", async function () {
    const { registry, generator, transporter, processor, oracle, create } =
      await networkHelpers.loadFixture(deployRegistry);
    await expect(create()).to.emit(registry, "ManifestCreated").withArgs(1n, generator.address, documentHash);
    await expect(registry.connect(oracle).recordPickupWeight(1, 10_000, sealHash))
      .to.emit(registry, "WeightRecorded").withArgs(1n, true, 10_000n, sealHash);
    await expect(registry.connect(transporter).confirmPickup(1))
      .to.emit(registry, "StatusChanged").withArgs(1n, 1n);
    await registry.connect(oracle).recordReceivedWeight(1, 9_800);
    await expect(registry.connect(processor).confirmReceipt(1))
      .to.emit(registry, "StatusChanged").withArgs(1n, 2n);
    await expect(registry.connect(processor).markTreated(1, proofHash))
      .to.emit(registry, "TreatmentRecorded").withArgs(1n, proofHash);
    const item = await registry.getManifest(1);
    expect(item.status).to.equal(3n);
    expect(item.flagged).to.equal(false);
    expect(item.docHash).to.equal(documentHash);
    expect(item.treatmentProofHash).to.equal(proofHash);
    expect(await registry.getManifestsByGenerator(generator.address)).to.deep.equal([1n]);
    await expect(registry.connect(processor).markTreated(1, ethers.id("replacement")))
      .to.be.revertedWithCustomError(registry, "WrongStatus");
    await expect(registry.connect(oracle).recordReceivedWeight(1, 9_900))
      .to.be.revertedWithCustomError(registry, "WrongStatus");
  });

  it("rejects unprivileged and revoked actors", async function () {
    const { registry, generator, transporter, processor, outsider, generatorRole } =
      await networkHelpers.loadFixture(deployRegistry);
    await expect(registry.connect(outsider).registerActor(outsider.address, generatorRole))
      .to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount");
    await registry.revokeActor(generator.address, generatorRole);
    await expect(registry.connect(generator).createManifest(
      transporter.address, processor.address, wasteCode, 10_000, documentHash,
    )).to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount");
    expect(await registry.manifestCount()).to.equal(0n);
  });

  it("rejects invalid weights, hash, unregistered assignee, and nonexistent manifest", async function () {
    const { registry, generator, transporter, processor, outsider } =
      await networkHelpers.loadFixture(deployRegistry);
    for (const weight of [0, 100_001]) {
      await expect(registry.connect(generator).createManifest(
        transporter.address, processor.address, wasteCode, weight, documentHash,
      )).to.be.revertedWithCustomError(registry, "InvalidInput");
    }
    await expect(registry.connect(generator).createManifest(
      transporter.address, processor.address, wasteCode, 10_000, ethers.ZeroHash,
    )).to.be.revertedWithCustomError(registry, "InvalidInput");
    await expect(registry.connect(generator).createManifest(
      outsider.address, processor.address, wasteCode, 10_000, documentHash,
    )).to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount");
    await expect(registry.getManifest(1)).to.be.revertedWithCustomError(registry, "UnknownManifest");
  });

  it("enforces the assigned actor, stage order, and one reading per stage", async function () {
    const { registry, transporter, processor, oracle, otherTransporter, create } =
      await networkHelpers.loadFixture(deployRegistry);
    await create();
    await expect(registry.connect(processor).confirmReceipt(1))
      .to.be.revertedWithCustomError(registry, "WrongStatus");
    await expect(registry.connect(transporter).confirmPickup(1))
      .to.be.revertedWithCustomError(registry, "WeightMissing");
    await registry.connect(oracle).recordPickupWeight(1, 10_000, sealHash);
    await expect(registry.connect(oracle).recordPickupWeight(1, 9_000, sealHash))
      .to.be.revertedWithCustomError(registry, "WeightAlreadyRecorded");
    await expect(registry.connect(otherTransporter).confirmPickup(1))
      .to.be.revertedWithCustomError(registry, "WrongActor");
    await registry.connect(transporter).confirmPickup(1);
    await expect(registry.connect(processor).confirmReceipt(1))
      .to.be.revertedWithCustomError(registry, "WeightMissing");
    await registry.connect(oracle).recordReceivedWeight(1, 9_800);
    await expect(registry.connect(oracle).recordReceivedWeight(1, 9_700))
      .to.be.revertedWithCustomError(registry, "WeightAlreadyRecorded");
  });

  it("accepts a difference exactly at the tolerance captured at creation", async function () {
    const { registry, processor, prepareReceipt } = await networkHelpers.loadFixture(deployRegistry);
    await prepareReceipt(9_500);
    await registry.setTolerance(100);
    await expect(registry.connect(processor).confirmReceipt(1)).not.to.emit(registry, "AnomalyDetected");
    const item = await registry.getManifest(1);
    expect(item.flagged).to.equal(false);
    expect(item.toleranceBps).to.equal(500n);
  });

  it("blocks treatment on a weight anomaly until the auditor resolves it", async function () {
    const { registry, processor, auditor, prepareReceipt } = await networkHelpers.loadFixture(deployRegistry);
    await prepareReceipt(1_000);
    await expect(registry.connect(processor).confirmReceipt(1))
      .to.emit(registry, "AnomalyDetected").withArgs(1n, 10_000n, 1_000n);
    const item = await registry.getManifest(1);
    expect(item.status).to.equal(2n);
    expect(item.flagged).to.equal(true);
    await expect(registry.connect(processor).markTreated(1, proofHash))
      .to.be.revertedWithCustomError(registry, "FlagStillOpen");
    await expect(registry.connect(processor).resolveFlag(1, proofHash))
      .to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount");
    await expect(registry.connect(auditor).resolveFlag(1, proofHash))
      .to.emit(registry, "FlagResolved").withArgs(1n, proofHash);
    expect((await registry.getManifest(1)).flagged).to.equal(false);
    await registry.connect(processor).markTreated(1, proofHash);
    expect((await registry.getManifest(1)).status).to.equal(3n);
  });

  it("records manual flags without advancing the manifest", async function () {
    const { registry, auditor, oracle, create } = await networkHelpers.loadFixture(deployRegistry);
    await create();
    await expect(registry.connect(auditor).flagManually(1, proofHash))
      .to.emit(registry, "ManuallyFlagged").withArgs(1n, proofHash);
    await expect(registry.connect(oracle).recordPickupWeight(1, 10_000, sealHash))
      .to.be.revertedWithCustomError(registry, "FlagStillOpen");
    await registry.connect(auditor).resolveFlag(1, proofHash);
    expect((await registry.getManifest(1)).status).to.equal(0n);
    await expect(registry.connect(auditor).resolveFlag(1, proofHash))
      .to.be.revertedWithCustomError(registry, "FlagNotOpen");
  });
});
