import { randomUUID } from 'crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { verifyMerkleProof } from '../src/modules/receipts/merkle.util';
import { SettlementBatchScheduler } from '../src/modules/settlement/settlement-batch.scheduler';

describe('Receipt inclusion proofs (e2e)', () => {
  let app: INestApplication;
  const escrowId = randomUUID();
  const sessionId = randomUUID();
  const randomHash = () => '0x' + (randomUUID() + randomUUID()).replace(/-/g, '');

  const postReceipt = async (): Promise<string> => {
    const receiptHash = randomHash();
    await request(app.getHttpServer())
      .post('/receipts')
      .send({
        escrowId,
        sessionId,
        fromAgent: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
        toAgent: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
        amount: 0.01,
        receiptHash,
        signature: '0x' + 'cd'.repeat(65),
      })
      .expect(201);
    return receiptHash;
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('proves every receipt of a settled batch against the settlement root', async () => {
    const hashes: string[] = [];
    for (let i = 0; i < 5; i += 1) hashes.push(await postReceipt());

    await app.get(SettlementBatchScheduler).runOnce(new Date(Date.now() + 120_000));

    const settlements = await request(app.getHttpServer())
      .get('/settlements')
      .query({ escrowId })
      .expect(200);
    expect(settlements.body).toHaveLength(1);
    const root = settlements.body[0].receiptsHash;

    for (const [index, receiptHash] of hashes.entries()) {
      const res = await request(app.getHttpServer()).get(`/receipts/proof/${receiptHash}`).expect(200);
      expect(res.body).toMatchObject({
        receiptHash,
        settlementId: settlements.body[0].id,
        index,
        leafCount: 5,
        root,
      });
      expect(verifyMerkleProof(receiptHash, res.body.proof, root)).toBe(true);
    }
  });

  it('answers 409 for a receipt that is not batched yet', async () => {
    const pending = await postReceipt();
    await request(app.getHttpServer()).get(`/receipts/proof/${pending}`).expect(409);
  });

  it('answers 404 for an unknown receipt and 400 for a malformed hash', async () => {
    await request(app.getHttpServer()).get(`/receipts/proof/${randomHash()}`).expect(404);
    await request(app.getHttpServer()).get('/receipts/proof/not-a-hash').expect(400);
  });

  it('verifies a submitted proof without touching the database', async () => {
    const leaf = randomHash();
    const ok = await request(app.getHttpServer())
      .post('/receipts/proof/verify')
      .send({ receiptHash: leaf, proof: [], root: leaf })
      .expect(200);
    expect(ok.body).toEqual({ valid: true });

    const bad = await request(app.getHttpServer())
      .post('/receipts/proof/verify')
      .send({ receiptHash: leaf, proof: [randomHash()], root: leaf })
      .expect(200);
    expect(bad.body).toEqual({ valid: false });
  });
});
