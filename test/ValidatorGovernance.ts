import { expect } from "chai";
import { network } from "hardhat";

const { ethers, networkHelpers } = await network.create();

async function deployGovernance() {
  const signers = await ethers.getSigners();
  const [a, b, c, d, e, f, g, candidate, alternate] = signers;
  const validators = [a, b, c, d, e, f, g] as const;
  const addresses = [a.address, b.address, c.address, d.address, e.address, f.address, g.address] as const;
  const governance = await ethers.deployContract("ValidatorGovernance", [addresses, [0, 1, 2, 3, 3, 4, 5]]);
  return { governance, validators, candidate, alternate };
}

describe("ValidatorGovernance", function () {
  it("blocks a third validator in one sector and rejects non-validator voting", async function () {
    const { governance, candidate } = await networkHelpers.loadFixture(deployGovernance);
    expect(await governance.validatorCount()).to.equal(7n);
    expect(await governance.sectorCount(3)).to.equal(2n);
    await expect(governance.propose(candidate.address, 3, true))
      .to.be.revertedWithCustomError(governance, "InvalidChange");
    await governance.propose(candidate.address, 0, true);
    await expect(governance.connect(candidate).vote(1)).to.be.revertedWithCustomError(governance, "NotValidator");
  });

  it("requires five distinct votes and prevents repeat execution", async function () {
    const { governance, validators, candidate } = await networkHelpers.loadFixture(deployGovernance);
    await governance.propose(candidate.address, 0, true);
    expect((await governance.proposals(1)).requiredVotes).to.equal(5n);
    for (const validator of validators.slice(0, 4)) {
      await governance.connect(validator).vote(1);
    }
    await expect(governance.vote(1)).to.be.revertedWithCustomError(governance, "DuplicateVote");
    await expect(governance.execute(1)).to.be.revertedWithCustomError(governance, "InsufficientVotes");
    await governance.connect(validators[4]).vote(1);
    await expect(governance.execute(1))
      .to.emit(governance, "ValidatorChanged").withArgs(1n, candidate.address, true, 0n);
    expect(await governance.validatorCount()).to.equal(8n);
    await expect(governance.execute(1)).to.be.revertedWithCustomError(governance, "InvalidProposal");
  });

  it("invalidates a proposal after another proposal changes membership", async function () {
    const { governance, validators, candidate } = await networkHelpers.loadFixture(deployGovernance);
    const removed = validators[4];
    await governance.propose(removed.address, 3, false);
    await governance.propose(candidate.address, 0, true);
    for (const validator of validators.slice(0, 5)) {
      await governance.connect(validator).vote(1);
    }
    await expect(governance.execute(1))
      .to.emit(governance, "ValidatorChanged").withArgs(1n, removed.address, false, 3n);
    expect(await governance.validatorCount()).to.equal(6n);
    expect(await governance.sectorCount(3)).to.equal(1n);
    await expect(governance.vote(2)).to.be.revertedWithCustomError(governance, "StaleProposal");
  });
});
