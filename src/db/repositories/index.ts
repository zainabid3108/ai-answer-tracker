import type { Db } from 'mongodb';
import { AnswerRepository } from './answers.js';
import { AnswerRequestRepository } from './answerRequests.js';
import { BrandRepository } from './brands.js';
import { CitationRepository } from './citations.js';
import { MentionRepository } from './mentions.js';

export interface Repositories {
  requests: AnswerRequestRepository;
  answers: AnswerRepository;
  mentions: MentionRepository;
  citations: CitationRepository;
  brands: BrandRepository;
}

export function createRepositories(db: Db, now?: () => Date): Repositories {
  return {
    requests: new AnswerRequestRepository(db, now),
    answers: new AnswerRepository(db),
    mentions: new MentionRepository(db),
    citations: new CitationRepository(db),
    brands: new BrandRepository(db),
  };
}
